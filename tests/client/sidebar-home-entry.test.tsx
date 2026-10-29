import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Sidebar } from "@/shell/Sidebar";
import { MobileNav } from "@/shell/MobileNav";
import { useUIStore } from "@/store/ui";
import { useProjectsStore, type Feature, type Project } from "@/store/projects";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadStatusStore } from "@/store/thread-status";
import { useGlobalAgentStore } from "@/store/global-agent";
import type { WaitingEntryDto } from "@shared/api/thread-status";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, type Mounted } from "../helpers/mount.js";
import { stub } from "../helpers/typed.js";
import { managerThreadDto } from "../helpers/client-builders.js";

// Home and New thread were two rows to one page, which read as a duplicate.
// New thread is now the one entry, and it carries the waiting count: on the
// row, or on the pen when the sidebar is collapsed. The sidebar lists no
// workers: a worker is reached from its thread, and Home lists the ones that
// wait.

let view: Mounted | null = null;
afterEach(() => {
  // Unmount before the stores the sidebar reads are reset under it.
  runCleanups();
  act(() => {
    useUIStore.setState({ sidebarCollapsed: false });
    useProjectsStore.setState({ projects: [], byId: {}, bySlug: {} });
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false });
    useThreadStatusStore.getState().replace({ threads: [], waiting: [] });
    useGlobalAgentStore.setState({ agent: null });
  });
  document.body.innerHTML = "";
});

const broken = (i: number): WaitingEntryDto => ({
  key: `thread:t${i}:failed`, kind: "thread", waiting: "failed", threadId: `t${i}`, threadTitle: `Thread ${i}`,
  featureId: null, workerName: null, text: "provider returned 500", place: null
});

/** Three workers, all owned; `flagged` threads the server lists as broken. */
function seed(flagged: number, more: WaitingEntryDto[] = []) {
  const features = Array.from({ length: 3 }, (_, i) => stub<Feature>({
    id: `f${i}`, name: `feat-${i}`, tmuxWindowName: `w-${i}`, pinnedAt: null, ownerThreadId: "thr_a"
  }));
  useProjectsStore.setState({ projects: [stub<Project>({ id: "p1", name: "project-1", tmuxSessionName: "md-project-1", features })] });
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [...Array.from({ length: flagged }, (_, i) => broken(i)), ...more] }));
}

function render(node: React.ReactNode, path: string) {
  view = mount(node, { path });
  return view.host;
}

const rowLabels = (el: HTMLElement) => [...el.querySelectorAll("a")].map((a) => a.textContent?.trim()).filter(Boolean);

test("the sidebar has one entry to Home: New thread, current while Home is open", () => {
  seed(0);
  // A saved thread, so the Threads list renders and has something to come first.
  const at = "2026-10-02T12:00:00.000Z";
  act(() => useManagerThreadsStore.getState().replaceAll([managerThreadDto("thr_a", { title: "project-1 3.22 release", createdAt: at, lastActivityAt: at })]));
  const el = render(<Sidebar />, "/activity");
  expect(rowLabels(el)).not.toContain("Home");
  const newThread = el.querySelector<HTMLAnchorElement>('[data-slot="new-thread"]')!;
  expect(newThread.getAttribute("href")).toBe("/home?focus=composer");
  expect(newThread.getAttribute("aria-current")).toBe(null);
  // It leads the nav under the global agent's pinned row, ahead of the thread.
  expect(el.querySelector('[data-thread-title="project-1 3.22 release"]') === null).toBe(false);
  const links = [...el.querySelector("nav")!.querySelectorAll("a")];
  expect(links[0]?.getAttribute("data-slot")).toBe("global-agent");
  expect(links[1] === newThread).toBe(true);
  view!.unmount();
  const onHome = render(<Sidebar />, "/home");
  expect(onHome.querySelector('[data-slot="new-thread"]')!.getAttribute("aria-current")).toBe("page");
});

test("the waiting count sits on New thread, and on the pen when the sidebar is collapsed", () => {
  seed(2);
  const el = render(<Sidebar />, "/activity");
  // Read whole by a screen reader, not as a bare number.
  expect(el.querySelector('[data-slot="new-thread"] [role="img"][aria-label="2 items need you"]') === null).toBe(false);
  expect(el.querySelector('[data-slot="new-thread"]')!.textContent).toBe("New thread2");
  view!.unmount();
  act(() => useUIStore.setState({ sidebarCollapsed: true }));
  const collapsed = render(<Sidebar />, "/activity");
  expect(collapsed.querySelector('[data-slot="new-thread"] [aria-label="2 items need you"]') === null).toBe(false);
});

test("nothing waiting: no count anywhere", () => {
  seed(0);
  // Either colour: at zero nothing is urgent, so a badge that leaked through
  // would be named "0 items ready for review", not "… need you".
  const badge = '[role="img"][aria-label*="item"]';
  const el = render(<Sidebar />, "/activity");
  expect(el.querySelector(badge) === null).toBe(true);
  view!.unmount();
  // The phone's closed trigger is the only standing signal a phone has.
  // Suppression is AttentionBadge's own guard; the call site renders it
  // unconditionally.
  const phone = render(<MobileNav />, "/activity");
  const trigger = phone.querySelector('[aria-label="Open navigation"]')!;
  expect(trigger.querySelector(badge) === null).toBe(true);
  // Nor a bare "0", which `count && <Badge/>` would leave behind.
  expect(trigger.textContent).not.toContain("0");
});

test("the phone's drawer has no Home row either", () => {
  seed(0);
  const el = render(<MobileNav />, "/activity");
  act(() => { el.querySelector<HTMLElement>('[aria-label="Open navigation"]')!.click(); });
  const labels = [...document.querySelectorAll("a")].map((a) => a.textContent?.trim()).filter(Boolean);
  expect(labels).toContain("New thread");
  expect(labels).not.toContain("Home");
});

// What the badge counts is the list Home shows: a question a manager put to
// the user is in it, and an item whose worker is in no live project is not.
// Your agent's own question shows on its own row: the sidebar's count and the
// phone's menu leave it out, so it is not counted twice.
test("a manager's question counts on what opens Home; Your agent's own question does not", () => {
  const managerAsks: WaitingEntryDto = {
    key: "question:thr_a:input", kind: "question", waiting: "input", threadId: "thr_a", threadTitle: "project-1 3.22 release",
    featureId: null, workerName: null, text: "Tag 3.22 today? (+1 more)", place: null
  };
  const agentAsks: WaitingEntryDto = { key: "agent:agent:input", kind: "agent", waiting: "input", threadId: null, threadTitle: null, featureId: null, workerName: null, text: "Now?", place: null };
  act(() => useGlobalAgentStore.setState({ agent: { threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } }));
  seed(1, [agentAsks, managerAsks]);
  const el = render(<Sidebar />, "/activity");
  expect(el.querySelector('[data-slot="new-thread"] [aria-label="2 items need you"]') === null).toBe(false);
  view!.unmount();
  const phone = render(<MobileNav />, "/activity");
  expect(phone.querySelector('[aria-label="Open navigation"] [aria-label="2 items need you"]') === null).toBe(false);
});

test("the sidebar and the phone's drawer list threads and no workers", () => {
  seed(2);
  const at = "2026-10-02T12:00:00.000Z";
  const owner = managerThreadDto("thr_a", { title: "project-1 3.22 release", createdAt: at, lastActivityAt: at });
  act(() => useManagerThreadsStore.getState().replaceAll([owner]));
  const groups = (scope: ParentNode) => [...scope.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label"));
  const el = render(<Sidebar />, "/activity");
  // The thread that owns the three workers is listed; its workers are not.
  expect(el.querySelector('[data-thread-title="project-1 3.22 release"]') === null).toBe(false);
  expect(groups(el)).toEqual(["Threads"]);
  view!.unmount();
  const phone = render(<MobileNav />, "/activity");
  act(() => { phone.querySelector<HTMLElement>('[aria-label="Open navigation"]')!.click(); });
  const drawer = document.querySelector('[role="dialog"]')!;
  expect(drawer.querySelector('[data-thread-title="project-1 3.22 release"]') === null).toBe(false);
  expect(groups(drawer)).toEqual(["Threads"]);
});
