import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { HomePage } from "@/routes/home/HomePage";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore } from "@/store/projects";
import { useThreadStatusStore } from "@/store/thread-status";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { WaitingEntryDto } from "@shared/api/thread-status";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mount } from "../helpers/mount.js";
import { clientFeature, clientProject, managerThreadDto } from "../helpers/client-builders.js";

const at = "2026-09-27T00:00:00.000Z";
let pathname = "";

afterEach(() => {
  // Unmount before the stores Home reads are reset under it.
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false });
    useProjectsStore.getState().setProjectsState([]);
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
  });
});

const thread = (id: string, title: string, patch: Partial<ManagerThreadDto> = {}) => managerThreadDto(id, { title, ...patch });
const project = clientProject("p1", { features: [clientFeature("pr-33", { ownerThreadId: "thr_rel" })] });

const entry = (fields: Partial<WaitingEntryDto> & Pick<WaitingEntryDto, "kind" | "waiting">): WaitingEntryDto => ({
  key: `${fields.kind}:${fields.featureId ?? fields.threadId ?? "agent"}:${fields.waiting}`,
  threadId: null, threadTitle: null, featureId: null, workerName: null, text: "", place: null, ...fields
});
const failed = entry({ kind: "thread", waiting: "failed", threadId: "thr_y", threadTitle: "project-2 cache expiry", text: "provider returned 500" });
const asks = entry({ kind: "worker", waiting: "input", threadId: "thr_rel", threadTitle: "project-1 3.21 release", featureId: "pr-33", workerName: "pr-33", text: "Accept the write-behind risk?" });
const decision = entry({ kind: "thread", waiting: "decision", threadId: "thr_docs", threadTitle: "Docs overhaul", text: "**Two options**: keep the page, or drop it." });
const result = entry({ kind: "thread", waiting: "result", threadId: "thr_rel", threadTitle: "project-1 3.21 release", text: "Tagged 3.21; the changelog is written." });

/** What the server lists, in its order. */
function seed(waiting: WaitingEntryDto[]) {
  act(() => {
    useManagerThreadsStore.getState().replaceAll([thread("thr_rel", "project-1 3.21 release"), thread("thr_y", "project-2 cache expiry")]);
    useProjectsStore.getState().setProjectsState([project]);
    useThreadStatusStore.getState().replace({ threads: [], waiting });
  });
}

function Where() {
  pathname = useLocation().pathname;
  return null;
}

function render() {
  return mount(
    <MemoryRouter initialEntries={["/home"]}>
      <Routes>
        <Route path="/home" element={<HomePage />} />
        <Route path="*" element={null} />
      </Routes>
      <Where />
    </MemoryRouter>
  ).host;
}

const rowsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLAnchorElement>('section[aria-label="Waiting on you"] [data-waiting]')];

test("Home lists what waits on you in the server's order, each in its colour, and links into the thread", () => {
  seed([failed, asks, decision]);
  const el = render();
  const rows = rowsOf(el);
  expect(rows.map((r) => r.getAttribute("data-waiting"))).toEqual(["failed", "input", "decision"]);
  expect(rows.map((r) => r.querySelector('[data-slot="waiting-state"]')!.textContent)).toEqual(["Failed", "Needs you", "Decision needed"]);
  expect(rows[0]!.textContent).toContain("project-2 cache expiry");
  expect(rows[0]!.textContent).toContain("provider returned 500");
  expect(rows[1]!.textContent).toContain("pr-33");
  // The worker's name is a title people write: the body font, not mono.
  const workerName = [...rows[1]!.querySelectorAll("span")].find((s) => s.textContent === "pr-33")!;
  expect(workerName.className.split(/\s+/)).not.toContain("font-mono");
  // A decision reads its reply as plain words.
  expect(rows[2]!.querySelector('[data-slot="waiting-reason"]')!.textContent).toBe("manager · Two options: keep the page, or drop it.");
  // A failure red, a question yellow, a decision the accent.
  const colours = rows.map((r) => [r.querySelector('[aria-hidden]')!.className.split(/\s+/).find((t) => t.startsWith("bg-")), r.querySelector('[data-slot="waiting-state"]')!.className.split(/\s+/).find((t) => /^text-(status|red)/.test(t))]);
  expect(colours).toEqual([["bg-red", "text-red"], ["bg-status-input", "text-status-input-fg"], ["bg-status-review", "text-status-review"]]);
  expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/threads/thr_y", "/threads/thr_rel?worker=pr-33", "/threads/thr_docs"]);
  // One decision is a row of its own.
  expect(el.querySelector('[data-slot="waiting-fold"]') === null).toBe(true);
});

// Decisions and results to read hold nobody up, and pile up: two or more are
// one row, which opens in place. What needs the user stays a row each.
test("two or more decisions and results fold into one row that opens in place; what needs you stays a row each", () => {
  seed([asks, decision, result]);
  const el = render();
  const section = el.querySelector('section[aria-label="Waiting on you"]')!;
  expect(rowsOf(el).map((r) => r.getAttribute("data-waiting"))).toEqual(["input"]);
  const fold = section.querySelector<HTMLButtonElement>('[data-slot="waiting-fold"]')!;
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(fold.querySelector('[data-slot="waiting-title"]')!.textContent).toBe("2 to look at");
  expect(fold.querySelector('[data-slot="waiting-reason"]')!.textContent).toBe("Docs overhaul · project-1 3.21 release");
  act(() => { fold.click(); });
  expect(rowsOf(el).map((r) => [r.getAttribute("data-waiting"), r.getAttribute("href")])).toEqual([
    ["input", "/threads/thr_rel?worker=pr-33"],
    ["decision", "/threads/thr_docs"],
    ["result", "/threads/thr_rel"]
  ]);
  expect(rowsOf(el)[2]!.querySelector('[data-slot="waiting-state"]')!.textContent).toBe("Result to read");
  act(() => { fold.click(); });
  expect(rowsOf(el)).toHaveLength(1);
});

test("a thread stopped short waits on you as Stopped, with its reason, and opens the thread", () => {
  const reason = "schedule_wake failed 5 times in a row: when: Invalid input";
  seed([entry({ kind: "thread", waiting: "stopped", threadId: "thr_stuck", threadTitle: "Memory search cleanup", text: reason })]);
  const [stopped] = rowsOf(render());
  expect(stopped!.textContent).toContain("Memory search cleanup");
  expect([...stopped!.querySelectorAll("span")].some((s) => s.textContent === "manager")).toBe(true);
  expect(stopped!.textContent).toContain(reason);
  expect(stopped!.querySelector('[data-slot="waiting-state"]')!.textContent).toBe("Stopped");
  expect(stopped!.getAttribute("href")).toBe("/threads/thr_stuck");
});

test("Home without anything waiting shows only the composer", () => {
  seed([]);
  const el = render();
  expect(el.querySelector('section[aria-label="Waiting on you"]') === null).toBe(true);
  expect(el.textContent).toContain("What should we work on?");
  expect(el.querySelector("textarea#new-thread-composer") === null).toBe(false);
});

test("the composer starts a thread and opens it", async () => {
  seed([]);
  const calls: string[] = [];
  mockFetch(({ url, init }) => {
    calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
    return Response.json({ thread: thread("thr_new", "Ship it"), message: { threadId: "thr_new", messageId: "m1", wakeId: "w1" } }, { status: 201 });
  });
  const el = render();
  const box = el.querySelector<HTMLTextAreaElement>("textarea#new-thread-composer")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Ship it");
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    el.querySelector<HTMLButtonElement>('button[aria-label="Start thread"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(calls.some((c) => c.startsWith("POST /api/agents/manager/threads ") && c.includes('"content":"Ship it"'))).toBe(true);
  expect(pathname).toBe("/threads/thr_new");
});

test("New thread while already on Home puts the cursor in the composer", async () => {
  seed([]);
  const { host } = mount(
    <MemoryRouter initialEntries={["/home"]}>
      <Link to="/home?focus=composer" data-testid="new-thread">New thread</Link>
      <Routes><Route path="/home" element={<HomePage />} /></Routes>
    </MemoryRouter>
  );
  const box = host.querySelector<HTMLTextAreaElement>("textarea#new-thread-composer")!;
  expect(document.activeElement === box).toBe(false);
  await act(async () => { host.querySelector<HTMLAnchorElement>('[data-testid="new-thread"]')!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(document.activeElement === box).toBe(true);
});

/** The composer and the waiting list, in document order: what a screen
 *  reader reads and Tab walks, which must match what the screen shows. */
function order(el: HTMLElement) {
  const composer = el.querySelector("textarea#new-thread-composer")!;
  const waiting = el.querySelector('section[aria-label="Waiting on you"]')!;
  return composer.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING ? "composer, waiting" : "waiting, composer";
}

test("a desktop Home reads the composer first, then what waits under it", () => {
  seed([failed]);
  expect(order(render())).toBe("composer, waiting");
});

test("a phone's Home reads what waits first, then the composer at the bottom, as it shows them", () => {
  onCleanup(fakePhoneWidth());
  seed([failed]);
  expect(order(render())).toBe("waiting, composer");
});

// The agent above the threads asks the user too: its question is on Home,
// first, and opens its page. On a phone its own row is inside the drawer.
test("the agent's own question is Home's first row: its name, the question alone, and a way to its page", () => {
  seed([entry({ kind: "agent", waiting: "input", text: "Send the weekly summary now?" }), failed]);
  act(() => {
    useGlobalAgentStore.setState({ agent: { threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [{ id: "q_9", question: "Send the weekly summary now?", options: [], askedAt: at }] } });
  });
  onCleanup(() => useGlobalAgentStore.setState({ agent: null }));
  const el = render();
  const rows = [...el.querySelectorAll<HTMLAnchorElement>('section[aria-label="Waiting on you"] [data-waiting]')];
  expect([rows[0]!.getAttribute("data-waiting"), rows[0]!.getAttribute("href")]).toEqual(["input", "/agent"]);
  expect(rows[0]!.querySelector('[data-slot="waiting-title"]')!.textContent).toBe("Your agent");
  expect(rows[0]!.querySelector('[data-slot="waiting-state"]')!.textContent).toBe("Needs you");
  // Nobody stands between the user and it: the line is the question, with no name and no dot before it.
  expect(rows[0]!.querySelector('[data-slot="waiting-reason"]')!.textContent).toBe("Send the weekly summary now?");
  // Once it has a name, the row carries it.
  act(() => { useGlobalAgentStore.setState({ agent: { ...useGlobalAgentStore.getState().agent!, name: "Juno", named: true } }); });
  expect(el.querySelector('section[aria-label="Waiting on you"] [data-waiting] [data-slot="waiting-title"]')!.textContent).toBe("Juno");
});
