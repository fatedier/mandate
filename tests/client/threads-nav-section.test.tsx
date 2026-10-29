import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ThreadsNavSection } from "@/shell/ThreadsNavSection";
import { Sidebar } from "@/shell/Sidebar";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore, type Feature, type Project } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { emptyPlan } from "@shared/api/plans";
import { useMonitorActivityStore } from "@/store/monitor-activity";
import { useWakeActivityStore } from "@/store/wake-activity";
import type { ArchivedThreadDto, ManagerThreadDto } from "@shared/api/agents";
import { useUIStore } from "@/store/ui";
import { mockFetch } from "../helpers/fetch.js";
import { toast } from "sonner";
import type { WorkItemDto } from "@shared/api/work-items";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { clientFeature, clientProject, managerThreadDto } from "../helpers/client-builders.js";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { useThreadStatusStore } from "@/store/thread-status";
import type { ThreadDot } from "@shared/thread-dot";
import type { WaitingEntryDto } from "@shared/api/thread-status";

const at = "2026-09-27T00:00:00.000Z";

afterEach(() => {
  // Unmount before the stores the threads list reads are reset under it.
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    useUIStore.setState({ archivedThreadsOpen: false });
    useProjectsStore.getState().setProjectsState([]);
    useWorkItemsStore.setState({ items: new Map() });
    useFeaturePlansStore.setState({ plans: new Map() });
    useMonitorActivityStore.setState({ waitingByThread: new Map(), listRevision: null });
    useWakeActivityStore.getState().applySnapshot([]);
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
  });
});

/** The states the server worked out, and what it lists, as its snapshot sends them. */
function states(byThread: Record<string, ThreadDot>, waiting: WaitingEntryDto[] = []) {
  act(() => useThreadStatusStore.getState().replace({
    threads: Object.entries(byThread).map(([threadId, state]) => ({ threadId, state })), waiting
  }));
}

const listed = (fields: Partial<WaitingEntryDto> & Pick<WaitingEntryDto, "kind" | "waiting">): WaitingEntryDto => ({
  key: `${fields.kind}:${fields.featureId ?? fields.threadId ?? "agent"}:${fields.waiting}`,
  threadId: null, threadTitle: null, featureId: null, workerName: null, text: "", place: null, ...fields
});
const parserAsks = listed({ kind: "worker", waiting: "input", threadId: "A", threadTitle: "Thread A", featureId: "parser", workerName: "parser", text: "Keep the old flag as an alias?" });

const thread = (id: string, patch: Partial<ManagerThreadDto> = {}) => managerThreadDto(id, { title: `Thread ${id}`, ...patch });

function feature(id: string, ownerThreadId: string | null): Feature {
  return clientFeature(id, { ownerThreadId });
}

function project(features: Feature[]): Project {
  return clientProject("p1", { features });
}

function workItem(featureId: string): WorkItemDto {
  return {
    id: `wi-${featureId}`, featureId, projectId: "p1", title: featureId,
    lastActivityAt: at, createdAt: at, updatedAt: at,
    failedAt: null, failedMessage: null, failedKind: null
  };
}

/** A worker asks: a question in its plan, and no flag. */
function asks(featureId: string) {
  useFeaturePlansStore.getState().upsert({ ...emptyPlan(featureId), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at }, "fetch");
}

/** A's worker asked and the whole thread rests, so A waits on the user; B is the newest and unread; C is idle and old. */
function seed() {
  act(() => {
    useManagerThreadsStore.getState().replaceAll([
      thread("A", { lastActivityAt: "2026-09-27T08:00:00.000Z" }),
      thread("B", { lastActivityAt: "2026-09-27T12:00:00.000Z", lastVisibleSeq: 9, seenSeq: 3 }),
      thread("C", { lastActivityAt: "2026-09-27T07:00:00.000Z" })
    ]);
    useProjectsStore.getState().setProjectsState([project([feature("parser", "A"), feature("docs", "C")])]);
    useWorkItemsStore.getState().upsert(workItem("parser"));
    asks("parser");
  });
  states({ A: "needs_you", B: "idle", C: "idle" }, [parserAsks]);
}

let pathname = "";
function LocationSpy() {
  pathname = useLocation().pathname;
  return null;
}

/** What a mark draws: each shape, its geometry and what fills or strokes it. */
function shapes(mark: Element) {
  return [...(mark.querySelector("svg")?.children ?? [])].map((shape) => ({
    tag: shape.tagName.toLowerCase(),
    r: shape.getAttribute("r"),
    d: shape.getAttribute("d"),
    fill: shape.getAttribute("fill"),
    stroke: shape.getAttribute("stroke"),
    dash: shape.getAttribute("stroke-dasharray")
  }));
}
const SOLID_DOT = [{ tag: "circle", r: "3", d: null, fill: "currentColor", stroke: null, dash: null }];

function render(node: React.ReactNode, at = "/projects") {
  return mount(<MemoryRouter initialEntries={[at]}>{node}<LocationSpy /></MemoryRouter>).host;
}

test("threads sort needs-you first, then newest; the dot and the bold title say why", () => {
  seed();
  const el = render(<ThreadsNavSection />);
  const rows = [...el.querySelectorAll<HTMLElement>("[data-thread-title]")];
  expect(rows.map((r) => r.getAttribute("data-thread-title"))).toEqual(["Thread A", "Thread B", "Thread C"]);
  expect(rows[0]!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("state: needs you");
  expect(rows[2]!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("state: idle");
  // Idle draws nothing: a dot on every row says nothing. The slot stays, so titles line up.
  const idleDot = rows[2]!.querySelector<HTMLElement>('[role="img"]')!;
  expect(idleDot.className.split(/\s+/)).toContain("size-2.5");
  expect(idleDot.querySelector("svg") === null).toBe(true);
  // Unread: B has a row the user has not seen. Its bright, bold title says so;
  // no word beside it takes the title's room, and a screen reader still hears it.
  expect(rows[1]!.dataset.unread).toBe("true");
  expect(rows[1]!.querySelector(".font-semibold")?.textContent).toBe("Thread B");
  expect([...rows[1]!.querySelectorAll("span")].filter((s) => s.textContent === "New").map((s) => s.className)).toEqual(["sr-only"]);
  expect(rows[2]!.dataset.unread).toBeUndefined();
  expect(rows[2]!.textContent).not.toContain("New");
});

test("clicking a thread opens its page", () => {
  seed();
  const el = render(<ThreadsNavSection />);
  const b = el.querySelector<HTMLElement>('[data-thread-title="Thread B"]')!;
  act(() => b.click());
  expect(pathname).toBe("/threads/B");
});

test("a thread's mark is the server's state: a question the solid yellow dot, idle nothing", () => {
  seed();
  const el = render(<ThreadsNavSection />);
  const rows = [...el.querySelectorAll<HTMLElement>("[data-thread-title]")];
  expect(rows.map((r) => r.getAttribute("data-thread-title"))).toEqual(["Thread A", "Thread B", "Thread C"]);
  const asked = rows[0]!.querySelector<HTMLElement>('[role="img"]')!;
  expect(asked.getAttribute("data-mark")).toBe("dot");
  expect(shapes(asked)).toEqual(SOLID_DOT);
  expect(asked.querySelector("svg")!.getAttribute("class")).toContain("text-status-input");
  const quiet = rows[2]!.querySelector<HTMLElement>('[role="img"]')!;
  expect(quiet.getAttribute("aria-label")).toBe("state: idle");
  expect(quiet.getAttribute("data-mark")).toBe(null);
  // A decision for the user sorts above the rest, below what needs them.
  states({ A: "needs_you", B: "idle", C: "decision" });
  expect([...el.querySelectorAll<HTMLElement>("[data-thread-title]")].map((r) => r.getAttribute("data-thread-title"))).toEqual(["Thread A", "Thread C", "Thread B"]);
});

// Watching: the manager and its workers all sleep, but one
// waits on a monitor (Codex in a pane, CI) and will wake by itself. It read
// as idle, like a thread that has stopped. A grey clock: waiting on a time or
// a condition, nothing running. A turn running reads working: the green dot
// that breathes wherever the app shows something running (a blue one sat
// 0.07 from the review dot, OKLab; the turning arc that replaced it spun out
// of step from row to row).
test("a thread whose worker or manager waits on a monitor, with nothing running, is watching: a grey clock; running, a breathing green dot", () => {
  act(() => {
    useManagerThreadsStore.getState().replaceAll([
      thread("A", { lastActivityAt: "2026-09-27T08:00:00.000Z" }),
      thread("B", { lastActivityAt: "2026-09-27T12:00:00.000Z" }),
      thread("C", { lastActivityAt: "2026-09-27T07:00:00.000Z" })
    ]);
    useProjectsStore.getState().setProjectsState([project([feature("parser", "A"), feature("docs", "C")])]);
  });
  // A's worker waits on its Codex pane, B's manager on a CI command.
  states({ A: "watching", B: "watching", C: "idle" });
  const el = render(<ThreadsNavSection />);
  const dot = (title: string) => el.querySelector<HTMLElement>(`[data-thread-title="${title}"] [role="img"]`)!;
  for (const title of ["Thread A", "Thread B"]) {
    expect(dot(title).getAttribute("aria-label")).toBe("state: watching");
    expect(dot(title).getAttribute("data-mark")).toBe("clock");
    // A face and its hands, stroked, nothing filled.
    expect(shapes(dot(title))).toEqual([
      { tag: "circle", r: "3.1", d: null, fill: "none", stroke: "currentColor", dash: null },
      { tag: "path", r: null, d: "M4 2.3V4.1l1.3 0.8", fill: "none", stroke: "currentColor", dash: null }
    ]);
    expect(dot(title).querySelector("svg")!.getAttribute("class")).toContain("text-faint");
    // Every mark sits in the same 10px slot, so the titles line up.
    expect(dot(title).className.split(/\s+/)).toContain("size-2.5");
  }
  expect(dot("Thread C").getAttribute("aria-label")).toBe("state: idle");
  expect(dot("Thread C").querySelector("svg") === null).toBe(true);
  expect(dot("Thread C").className.split(/\s+/)).toContain("size-2.5");
  // Its worker running a turn reads working again.
  states({ A: "working", B: "watching", C: "idle" });
  expect(dot("Thread A").getAttribute("aria-label")).toBe("state: working");
  expect(dot("Thread A").getAttribute("data-mark")).toBe("pulse");
  // The asking dots' shape, in the running green, breathing.
  expect(shapes(dot("Thread A"))).toEqual(SOLID_DOT);
  const classes = dot("Thread A").querySelector("svg")!.getAttribute("class")!.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["animate-working", "text-live"]));
  expect(classes.includes("text-phase-working")).toBe(false);
});

// Each row's breathing began when its turn did, so two running threads
// breathed out of step. A browser starts a CSS animation afresh whenever its
// element comes back into the document: a turn starting, and also a row moved
// in the sorted list, or the sidebar shown again. Each time a working dot's
// animation starts it is set to the document timeline's origin: one beat.
test("every working dot breathes on one beat: each time its animation starts, its row moved or not, it starts at the timeline's origin", () => {
  const started: { row: string | null; startTime: number | null }[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations")!;
  onCleanup(() => Object.defineProperty(Element.prototype, "getAnimations", descriptor));
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true, writable: true,
    value(this: Element) {
      // A breathing animation per element carrying the class, as the browser keeps one.
      if (!this.getAttribute("class")?.split(/\s+/).includes("animate-working")) return [];
      const animation = { row: this.closest("[data-thread-title]")?.getAttribute("data-thread-title") ?? null, startTime: 1234 as number | null };
      started.push(animation);
      return [animation];
    }
  });
  act(() => {
    useManagerThreadsStore.getState().replaceAll([
      thread("A", { lastActivityAt: "2026-09-27T08:00:00.000Z" }),
      thread("B", { lastActivityAt: "2026-09-27T07:00:00.000Z" })
    ]);
    useProjectsStore.getState().setProjectsState([project([feature("parser", "A"), feature("docs", "B")])]);
  });
  states({ A: "working", B: "working" });
  const el = render(<ThreadsNavSection />);
  const titles = () => [...el.querySelectorAll("[data-thread-title]")].map((row) => row.getAttribute("data-thread-title"));
  // What the browser fires as a mark's animation starts.
  const animationStarts = (title: string) => act(() => {
    el.querySelector(`[data-thread-title="${title}"] svg`)!.dispatchEvent(new CustomEvent("animationstart", { bubbles: true }));
  });
  expect(titles()).toEqual(["Thread A", "Thread B"]);
  animationStarts("Thread A");
  animationStarts("Thread B");
  expect(started).toStrictEqual([{ row: "Thread A", startTime: 0 }, { row: "Thread B", startTime: 0 }]);
  // B's newer activity moves it above A, both still working: A's row is
  // moved, and its animation starts again.
  act(() => useManagerThreadsStore.getState().replaceAll([
    thread("A", { lastActivityAt: "2026-09-27T08:00:00.000Z" }),
    thread("B", { lastActivityAt: "2026-09-27T09:00:00.000Z" })
  ]));
  expect(titles()).toEqual(["Thread B", "Thread A"]);
  animationStarts("Thread A");
  expect(started).toStrictEqual([{ row: "Thread A", startTime: 0 }, { row: "Thread B", startTime: 0 }, { row: "Thread A", startTime: 0 }]);
});

test("the Threads header carries no total; New thread counts what waits on you, yellow when a question waits", () => {
  seed();
  const el = render(<Sidebar />);
  const threadsHeader = el.querySelector('[role="group"][aria-label="Threads"]')!.previousElementSibling!;
  expect(threadsHeader.textContent).toBe("Threads");
  // Sentence case at the rows' size, not an uppercase eyebrow.
  expect(threadsHeader.querySelector("span")!.className.split(/\s+/)).toContain("label-group");
  const newThread = el.querySelector<HTMLElement>('[data-slot="new-thread"]')!;
  // The badge's 1: parser asked and its thread rests; docs, the other worker, waits on nothing.
  expect(newThread.textContent).toBe("New thread1");
  const badge = newThread.querySelector<HTMLElement>('[aria-label="1 item needs you"]')!;
  expect(badge.className.split(/\s+/)).toContain("text-status-input-fg");
});

test("New thread's count takes the review colour when only decisions and results wait", () => {
  seed();
  states({ A: "decision", B: "idle", C: "idle" }, [listed({ kind: "thread", waiting: "decision", threadId: "A", threadTitle: "Thread A", text: "Pick one." })]);
  const el = render(<Sidebar />);
  const badge = el.querySelector<HTMLElement>('[data-slot="new-thread"] [aria-label="1 item to look at"]')!;
  expect(badge.className).toContain("text-status-review");
});

test("New thread's count turns red when a thread broke, over a question waiting beside it", () => {
  seed();
  states({ A: "needs_you", B: "idle", C: "failed" }, [listed({ kind: "thread", waiting: "failed", threadId: "C", threadTitle: "Thread C", text: "provider returned 500" }), parserAsks]);
  const el = render(<Sidebar />);
  const badge = el.querySelector<HTMLElement>('[data-slot="new-thread"] [aria-label="2 items need you"]')!;
  expect(badge.className.split(/\s+/)).toContain("text-red");
  expect(badge.className.split(/\s+/)).not.toContain("text-status-input-fg");
});

const archivedEntry = (id: string, title: string, archivedAt: string, patch: Partial<ArchivedThreadDto> = {}): ArchivedThreadDto => ({
  id, title, archivedAt, workers: 0, canvases: 0, ...patch
});

function seedArchived() {
  act(() => useManagerThreadsStore.setState({
    archived: [
      archivedEntry("thr_old", "project-1 cache expiry", "2026-10-13T09:00:00.000Z", { workers: 2, canvases: 1 }),
      archivedEntry("thr_older", "project-2 flaky upload", "2026-10-12T09:00:00.000Z", { workers: 3, canvases: 2 })
    ],
    archivedLoaded: true
  }));
}

const archivedToggle = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.textContent?.startsWith("Archived"));
const archivedRows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="group"][aria-label="Archived threads"] a')]
  .map((a) => [...a.querySelectorAll("span")].map((s) => s.textContent).filter(Boolean));

test("the Archived group shows only with archived threads: its count, closed, then each one's title and date, the newest first, and stays as left", () => {
  seed();
  const el = render(<ThreadsNavSection />);
  expect(archivedToggle(el) === undefined).toBe(true);
  seedArchived();
  expect(archivedToggle(el)!.textContent).toBe("Archived2");
  expect(archivedToggle(el)!.getAttribute("aria-expanded")).toBe("false");
  expect(archivedRows(el)).toEqual([]);
  act(() => archivedToggle(el)!.click());
  expect(archivedRows(el)).toEqual([["project-1 cache expiry", "Oct 13"], ["project-2 flaky upload", "Oct 12"]]);
  // Remembered for the next page load.
  expect(useUIStore.getState().archivedThreadsOpen).toBe(true);
  const row = el.querySelector<HTMLElement>('[role="group"][aria-label="Archived threads"] a')!;
  act(() => row.click());
  expect(pathname).toBe("/threads/thr_old");
});

test("with no open thread, the archived ones still have their group under the heading", () => {
  seedArchived();
  const el = render(<ThreadsNavSection />);
  expect(el.textContent).toContain("Threads");
  expect(archivedToggle(el)!.textContent).toBe("Archived2");
  expect(el.querySelector('[role="group"][aria-label="Threads"]') === null).toBe(true);
});

test("the group's menu deletes every archived thread after a dialog that counts what goes", async () => {
  const calls = mockFetch(({ method }) => method === "DELETE" ? Response.json({ ok: true, count: 2, skipped: 0 }) : Response.json({ archived: [] }));
  seed();
  seedArchived();
  const el = render(<ThreadsNavSection />);
  const trigger = el.querySelector<HTMLElement>('[aria-label="Archived thread actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((n) => n.textContent === "Delete all archived threads…")!;
  expect(item.getAttribute("data-variant")).toBe("destructive");
  await act(async () => { item.click(); await new Promise((r) => setTimeout(r, 0)); });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector("h2")!.textContent).toBe("Delete all 2 archived threads permanently?");
  expect(dialog.textContent).toContain("This removes, for good, every archived thread’s conversation, 5 workers with their chats and plans, and 3 canvases.");
  expect(dialog.textContent).toContain("Open threads are not touched. Worktrees and branches still on disk are left as they are. This can’t be undone.");
  const button = (label: string) => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  expect(calls.filter((c) => c.method === "DELETE")).toStrictEqual([]);
  await act(async () => { button("Delete 2 threads").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toStrictEqual(["/api/agents/manager/threads?archived=1"]);
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
});

async function deleteAllFromMenu(el: HTMLElement, button: string) {
  const trigger = el.querySelector<HTMLElement>('[aria-label="Archived thread actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((n) => n.textContent === "Delete all archived threads…")!;
  await act(async () => { item.click(); await new Promise((r) => setTimeout(r, 0)); });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === button)!;
  await act(async () => { confirm.click(); await new Promise((r) => setTimeout(r, 0)); });
}

test("a thread left by delete all, its work still stopping, is said so", async () => {
  const said: string[] = [];
  const original = toast.message;
  toast.message = ((message: unknown) => { said.push(String(message)); return 0; }) as typeof toast.message;
  onCleanup(() => { toast.message = original; });
  mockFetch(({ method }) => method === "DELETE" ? Response.json({ ok: true, count: 1, skipped: 1 }) : Response.json({ archived: [] }));
  seed();
  seedArchived();
  const el = render(<ThreadsNavSection />);
  await deleteAllFromMenu(el, "Delete 2 threads");
  expect(said).toStrictEqual(["1 thread was left: its work is still stopping. Try again in a moment."]);
});

test("delete all from an archived thread's page leaves for Home; from elsewhere the page stays", async () => {
  mockFetch(({ method }) => method === "DELETE" ? Response.json({ ok: true, count: 2, skipped: 0 }) : Response.json({ archived: [] }));
  seedArchived();
  const onPage = render(<ThreadsNavSection />, "/threads/thr_older");
  await deleteAllFromMenu(onPage, "Delete 2 threads");
  expect(pathname).toBe("/home");
  runCleanups();
  seedArchived();
  const elsewhere = render(<ThreadsNavSection />, "/projects");
  await deleteAllFromMenu(elsewhere, "Delete 2 threads");
  expect(pathname).toBe("/projects");
});

// A question is yellow, a failure red; the mark says which it shows.
test("a thread's failed mark is the red dot, named as failed or stopped", () => {
  const { host } = mount(<ThreadStateMark dot="failed" />);
  const mark = host.querySelector<HTMLElement>('[role="img"]')!;
  expect(mark.getAttribute("aria-label")).toBe("state: failed or stopped");
  expect(mark.getAttribute("data-mark")).toBe("dot");
  expect(mark.querySelector("svg")!.getAttribute("class")).toContain("text-red");
});

test("a decision or a result to read is the accent's solid dot, read out by its name", () => {
  for (const [dot, name] of [["decision", "state: decision needed"], ["result", "state: result to read"]] as const) {
    const { host } = mount(<ThreadStateMark dot={dot} />);
    const mark = host.querySelector<HTMLElement>('[role="img"]')!;
    expect(mark.getAttribute("aria-label")).toBe(name);
    expect(mark.getAttribute("data-mark")).toBe("dot");
    expect(mark.querySelector("svg")!.getAttribute("class")).toContain("text-status-review");
  }
});

test("a mark that comes later fades in and changes colour gently; one there as the sidebar opens is just there", () => {
  const svgClass = (host: HTMLElement) => host.querySelector("svg")?.getAttribute("class")?.split(/\s+/) ?? null;
  // The fade is on the mark's own box: the working dot's breath is the svg's animation.
  const fading = (host: HTMLElement) => host.querySelector("svg")?.parentElement?.className.split(/\s+/).includes("animate-in") ?? null;
  const opened = mount(<ThreadStateMark dot="needs_you" />);
  expect([fading(opened.host), svgClass(opened.host)!.includes("transition-colors")]).toEqual([false, true]);
  const { host, rerender } = mount(<ThreadStateMark dot="idle" />);
  expect(svgClass(host)).toBeNull();
  rerender(<ThreadStateMark dot="working" />);
  expect([fading(host), svgClass(host)!.includes("animate-in"), svgClass(host)!.includes("animate-working")]).toEqual([true, false, true]);
});
