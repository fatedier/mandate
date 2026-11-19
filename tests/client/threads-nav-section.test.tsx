import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { ThreadsNavSection } from "@/shell/ThreadsNavSection";
import { Sidebar } from "@/shell/Sidebar";
import { MobileNav } from "@/shell/MobileNav";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore, type ProjectWorker, type Project } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useWorkerPlansStore } from "@/store/worker-plans";
import { emptyPlan } from "@shared/api/plans";
import { useMonitorActivityStore } from "@/store/monitor-activity";
import { useWakeActivityStore } from "@/store/wake-activity";
import type { ArchivedThreadDto, ManagerThreadDto } from "@shared/api/agents";
import { mockFetch } from "../helpers/fetch.js";
import type { WorkItemDto } from "@shared/api/work-items";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { clientWorker, clientProject, managerThreadDto } from "../helpers/client-builders.js";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { useThreadStatusStore } from "@/store/thread-status";
import type { ThreadDot } from "@shared/thread-dot";
import type { WaitingEntryDto } from "@shared/api/thread-status";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useThreadTabsStore } from "@/store/thread-tabs";

const at = "2026-09-27T00:00:00.000Z";

afterEach(() => {
  // Unmount before the stores the threads list reads are reset under it.
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    useProjectsStore.getState().setProjectsState([]);
    useWorkItemsStore.setState({ items: new Map() });
    useWorkerPlansStore.setState({ plans: new Map() });
    useMonitorActivityStore.setState({ waitingByThread: new Map(), listRevision: null });
    useWakeActivityStore.setState({ activeByWorkerId: new Map() });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
    useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
    useAgentPageUi.setState({ open: true, narrowView: "chat", active: "page" });
  });
});

/** The states the server worked out, and what it lists, as its snapshot sends them. */
function states(byThread: Record<string, ThreadDot>, waiting: WaitingEntryDto[] = []) {
  act(() => useThreadStatusStore.getState().replace({
    threads: Object.entries(byThread).map(([threadId, state]) => ({ threadId, state })), waiting
  }));
}

const listed = (fields: Partial<WaitingEntryDto> & Pick<WaitingEntryDto, "kind" | "waiting">): WaitingEntryDto => ({
  key: `${fields.kind}:${fields.workerId ?? fields.threadId ?? "agent"}:${fields.waiting}`,
  threadId: null, threadTitle: null, workerId: null, workerName: null, text: "", place: null, ...fields
});
const parserAsks = listed({ kind: "worker", waiting: "input", threadId: "A", threadTitle: "Thread A", workerId: "parser", workerName: "parser", text: "Keep the old flag as an alias?" });

const thread = (id: string, patch: Partial<ManagerThreadDto> = {}) => managerThreadDto(id, { title: `Thread ${id}`, ...patch });

function worker(id: string, ownerThreadId: string | null): ProjectWorker {
  return clientWorker(id, { ownerThreadId });
}

function project(workers: ProjectWorker[]): Project {
  return clientProject("p1", { workers });
}

function workItem(workerId: string): WorkItemDto {
  return {
    id: `wi-${workerId}`, workerId, projectId: "p1", title: workerId,
    lastActivityAt: at, createdAt: at, updatedAt: at,
    failedAt: null, failedMessage: null, failedKind: null
  };
}

/** A worker asks: a question in its plan, and no flag. */
function asks(workerId: string) {
  useWorkerPlansStore.getState().upsert({ ...emptyPlan(workerId), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at }, "fetch");
}

/** A's worker asked and the whole thread rests, so A waits on the user; B is the newest and unread; C is idle and old. */
function seed() {
  act(() => {
    useManagerThreadsStore.getState().replaceAll([
      thread("A", { lastActivityAt: "2026-09-27T08:00:00.000Z" }),
      thread("B", { lastActivityAt: "2026-09-27T12:00:00.000Z", lastVisibleSeq: 9, seenSeq: 3 }),
      thread("C", { lastActivityAt: "2026-09-27T07:00:00.000Z" })
    ]);
    useProjectsStore.getState().setProjectsState([project([worker("parser", "A"), worker("docs", "C")])]);
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

// Each open thread's row has the thread page's ⋯ menu at its end, beside the
// link rather than in it; Open beside opens the thread in the personal agent's panel
// and goes there, closing the phone's drawer first.
test("a thread row's menu is the thread's own; Open beside opens it beside the personal agent and goes there", async () => {
  seed();
  const posted: unknown[] = [];
  mockFetch(({ url, method, init }) => {
    if (url.endsWith("/api/agents/personal/thread-tabs") && method === "POST") {
      posted.push(JSON.parse(String(init!.body)));
      return Response.json({ tabs: [{ threadId: "B", createdAt: at }] });
    }
    return Response.json({ commands: [] });
  });
  let left = 0;
  const el = render(<ThreadsNavSection onNavigate={() => { left += 1; }} />);
  const trigger = el.querySelector<HTMLElement>('[aria-label="Actions for Thread B"]')!;
  expect(trigger.closest("a") === null).toBe(true);
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((n) => n.textContent)).toEqual(["Open beside Personal agent", "Rename", "Compact now", "Archive thread"]);
  expect([pathname, left]).toEqual(["/projects", 0]);
  await act(async () => { items[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect([posted, pathname, left, useAgentPageUi.getState().active]).toEqual([[{ threadId: "B" }], "/agent", 1, "thread:B"]);
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
    useProjectsStore.getState().setProjectsState([project([worker("parser", "A"), worker("docs", "C")])]);
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
    useProjectsStore.getState().setProjectsState([project([worker("parser", "A"), worker("docs", "B")])]);
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

/** The phone's closed menu button, the one place a waiting count shows. */
const menuButton = (el: HTMLElement) => el.querySelector<HTMLElement>('[aria-label="Open navigation"]')!;

test("the Threads header carries no total, nor does New thread: the rows under it show what waits", () => {
  seed();
  const el = render(<Sidebar />);
  const threadsHeader = el.querySelector('[role="group"][aria-label="Threads"]')!.previousElementSibling!;
  expect(threadsHeader.textContent).toBe("Threads");
  // Sentence case at the rows' size, not an uppercase eyebrow.
  expect(threadsHeader.querySelector("span")!.className.split(/\s+/)).toContain("label-group");
  const newThread = el.querySelector<HTMLElement>('[data-slot="new-thread"]')!;
  expect(newThread.textContent).toBe("New thread");
  expect(newThread.querySelector('[role="img"]') === null).toBe(true);
});

test("the phone's menu button counts what waits on you, yellow when a question waits", () => {
  seed();
  const el = render(<MobileNav />);
  // The dot's 1: parser asked and its thread rests; docs, the other worker, waits on nothing.
  const dot = menuButton(el).querySelector<HTMLElement>('[aria-label="1 item needs you"]')!;
  expect(dot.className.split(/\s+/)).toContain("bg-status-input");
});

test("the phone's menu button's count takes the review colour when only decisions and results wait", () => {
  seed();
  states({ A: "decision", B: "idle", C: "idle" }, [listed({ kind: "thread", waiting: "decision", threadId: "A", threadTitle: "Thread A", text: "Pick one." })]);
  const el = render(<MobileNav />);
  const dot = menuButton(el).querySelector<HTMLElement>('[aria-label="1 item to look at"]')!;
  expect(dot.className.split(/\s+/)).toContain("bg-status-review");
});

test("the phone's menu button's count turns red when a thread broke, over a question waiting beside it", () => {
  seed();
  states({ A: "needs_you", B: "idle", C: "failed" }, [listed({ kind: "thread", waiting: "failed", threadId: "C", threadTitle: "Thread C", text: "provider returned 500" }), parserAsks]);
  const el = render(<MobileNav />);
  const dot = menuButton(el).querySelector<HTMLElement>('[aria-label="2 items need you"]')!;
  expect(dot.className.split(/\s+/)).toContain("bg-destructive");
  expect(dot.className.split(/\s+/)).not.toContain("bg-status-input");
});

const archivedEntry = (id: string, title: string, archivedAt: string, patch: Partial<ArchivedThreadDto> = {}): ArchivedThreadDto => ({
  id, title, archivedAt, lastActivityAt: archivedAt, workers: 0, canvases: 0, labels: [], projects: [], ...patch
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

// The sidebar keeps the open threads. Every thread, archived ones too, is on
// the Threads page: one row under the open ones leads there.
const allThreads = (el: HTMLElement) => el.querySelector<HTMLAnchorElement>('a[data-slot="all-threads"]');
const allThreadsSays = (el: HTMLElement) => {
  const link = allThreads(el);
  return link ? [link.getAttribute("href"), link.querySelector('[data-slot="all-threads-label"]')?.textContent, link.querySelector('[data-slot="all-threads-count"]')?.textContent] : null;
};

test("under the open threads one row leads to the Threads page, with the count of every thread, archived ones too", () => {
  seed();
  const el = render(<ThreadsNavSection />);
  expect(allThreadsSays(el)).toEqual(["/threads", "All threads", "3"]);
  seedArchived();
  expect(allThreadsSays(el)).toEqual(["/threads", "All threads", "5"]);
  act(() => allThreads(el)!.click());
  expect(pathname).toBe("/threads");
});

test("the sidebar has no Archived group: no fold, no archived row, no menu of theirs", () => {
  seed();
  seedArchived();
  const el = render(<ThreadsNavSection />);
  expect([...el.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Archived"))).toBe(false);
  expect(el.querySelector('[role="group"][aria-label="Archived threads"]') === null).toBe(true);
  expect(el.querySelector('[aria-label="Archived thread actions"]') === null).toBe(true);
  expect(el.textContent).not.toContain("project-1 cache expiry");
  // The open ones are as they were.
  expect(el.querySelectorAll('[role="group"][aria-label="Threads"] a[data-thread-title]').length).toBe(3);
});

test("with archived threads only, the row is there under the heading; with no thread at all, nothing is", () => {
  const none = render(<ThreadsNavSection />);
  expect([none.textContent, allThreads(none) === null]).toEqual(["", true]);
  seedArchived();
  expect(none.textContent).toContain("Threads");
  expect(allThreadsSays(none)).toEqual(["/threads", "All threads", "2"]);
  expect(none.querySelector('[role="group"][aria-label="Threads"]') === null).toBe(true);
});

// A question is yellow, a failure red; the mark says which it shows.
test("a thread's failed mark is the red dot, named as failed or stopped", () => {
  const { host } = mount(<ThreadStateMark dot="failed" />);
  const mark = host.querySelector<HTMLElement>('[role="img"]')!;
  expect(mark.getAttribute("aria-label")).toBe("state: failed or stopped");
  expect(mark.getAttribute("data-mark")).toBe("dot");
  expect(mark.querySelector("svg")!.getAttribute("class")).toContain("text-destructive");
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
