import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { FeatureActionsMenu } from "@/routes/window/FeatureActionsMenu";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { useSnapshotStore } from "@/store/snapshot";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useCommandsStore } from "@/store/commands";
import { newThreadState, useAgentChatStore } from "@/store/agent-chat";
import { onCleanup } from "../helpers/cleanup.js";
import { mount, settle, settleUntil } from "../helpers/mount.js";
import { resetBackgroundTasksStore } from "../helpers/subagent-client.js";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import type { BackgroundTaskDto } from "@shared/api-contracts";

test("one menu holds refresh, close and archive, with archive last", async () => {
  const win = { windowId: "@1", panes: [] } as unknown as SnapshotWindow;
  const { host } = mount(
    <MemoryRouter>
      <FeatureActionsMenu
        featureId="f1"
        featureName="Alpha"
        window={win}
        onClose={() => {}}
      />
    </MemoryRouter>
  );
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  expect(trigger === null).toBe(false);
  // Radix opens on pointerdown, not click.
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await settle();
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim());
  expect(items).toEqual(["Refresh panes", "Compact now", "Close", "Archive worker"]);
  // No bare icon button for these actions remains beside the menu.
  expect(host.querySelector('[aria-label="Refresh panes"]') === null).toBe(true);
});

test("without onClose the menu offers no Close", async () => {
  const { host } = mount(
    <MemoryRouter>
      <FeatureActionsMenu featureId="f1" featureName="Alpha" />
    </MemoryRouter>
  );
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim());
  expect(items).toEqual(["Refresh panes", "Compact now", "Archive worker"]);
  // The menu's own destructive item, as the thread's and the canvas's are.
  expect(document.querySelector('[role="menuitem"]:last-child')!.getAttribute("data-variant")).toBe("destructive");
});

test("a worker with an owner thread offers Open thread, which opens it", async () => {
  let at = "";
  function Where() { at = useLocation().pathname; return null; }
  const { host } = mount(
    <MemoryRouter initialEntries={["/projects/p/features/f"]}>
      <FeatureActionsMenu featureId="f1" featureName="Alpha" ownerThreadId="thr_a" onClose={() => {}} />
      <Where />
    </MemoryRouter>
  );
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await settle();
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((n) => n.textContent?.trim() === "Open thread");
  expect(item === undefined).toBe(false);
  act(() => item!.click());
  expect(at).toBe("/threads/thr_a");
});

test("the menu carries Pin to top / Unpin after Refresh, and calls onTogglePin", async () => {
  let toggled = 0;
  const menu = (pinned: boolean) => (
    <MemoryRouter>
      <FeatureActionsMenu featureId="f1" featureName="Alpha" pinned={pinned} onTogglePin={() => { toggled += 1; }} onClose={() => {}} />
    </MemoryRouter>
  );
  const { host, rerender } = mount(menu(false));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  expect(items.map((n) => n.textContent?.trim())).toEqual(["Refresh panes", "Compact now", "Pin to top", "Close", "Archive worker"]);
  act(() => { items[2]!.click(); });
  await settle();
  expect(toggled).toBe(1);

  // A pinned feature reads Unpin in the same place.
  rerender(menu(true));
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim()))
    .toEqual(["Refresh panes", "Compact now", "Unpin", "Close", "Archive worker"]);
});

test("Compact now asks for the worker's commands by itself, and is greyed while the worker's turn runs", async () => {
  // The menu alone, as on a worker's Plan or Terminal tab: no conversation on screen has asked for the list.
  const asked: string[] = [];
  mockFetch(({ url, method }) => {
    asked.push(`${method} ${url}`);
    return Response.json({ commands: [{ name: "/compact", description: "Summarize earlier messages to free up context", blocked: { running: "A turn is running" } }] });
  });
  onCleanup(() => {
    useWakeActivityStore.setState({ activeByFeatureId: new Map() });
    useCommandsStore.setState({ byScope: new Map(), noticeByScope: new Map() });
  });
  // What the page knows of a worker whose chat it has not loaded: that its turn is running.
  act(() => useWakeActivityStore.setState({ activeByFeatureId: new Map([["f-compact", { wakeId: "w1", startedAt: "2026-10-14T10:00:00.000Z" }]]) }));
  const { host } = mount(
    <MemoryRouter>
      <FeatureActionsMenu featureId="f-compact" featureName="Alpha" />
    </MemoryRouter>
  );
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  expect(asked).toStrictEqual(["GET /api/agents/workers/f-compact/commands"]);
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((n) => n.textContent?.trim() === "Compact now")!;
  expect(item.hasAttribute("data-disabled")).toBe(true);
});

async function openArchiveDialog(check: object, deleteResponse?: () => Response) {
  return openArchiveDialogWithCheck(() => new Response(JSON.stringify(check), { status: 200 }), deleteResponse);
}

async function openArchiveDialogWithCheck(checkResponse: () => Response, deleteResponse?: () => Response) {
  const calls: string[] = [];
  mockFetch(({ url, init }) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "GET" && url.includes("/archive-check")) return checkResponse();
    if (method === "DELETE" && deleteResponse) return deleteResponse();
    return new Response(JSON.stringify({ ok: true, cleanupFailures: [] }), { status: 200 });
  });
  const { host } = mount(
    <MemoryRouter>
      <FeatureActionsMenu featureId="f1" featureName="Alpha" featureMode="new-branch-new-worktree" branch="fix-x" hasWorktree onClose={() => {}} />
    </MemoryRouter>
  );
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await settle();
  const archiveItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((n) => n.textContent?.includes("Archive"))!;
  act(() => { archiveItem.click(); });
  await settle(10);
  return { calls };
}

test("archive dialog shows the findings and sends confirmed when the user archives anyway", async () => {
  const { calls } = await openArchiveDialog({
    dirtyFiles: 0, unmergedCommits: 4, branch: "fix-x", baseRef: "origin/master",
    findings: ['Branch "fix-x" has 4 commits not in origin/master.']
  });
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Branch "fix-x" has 4 commits not in origin/master.');
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Archive anyway")!;
  expect(button === undefined).toBe(false);
  await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 10)); });
  const del = calls.find((c) => c.startsWith("DELETE "))!;
  expect(del).toContain("confirmed=true");
});

test("a refusal found after the dialog opened shows its findings and offers Archive anyway", async () => {
  // Clean when the dialog opened; the worker dirtied the worktree before the click.
  const fresh = { dirtyFiles: 2, unmergedCommits: 0, branch: "fix-x", baseRef: "main", findings: ["2 uncommitted files in the worktree."] };
  let deletes = 0;
  const { calls } = await openArchiveDialog(
    { dirtyFiles: 0, unmergedCommits: 0, branch: "fix-x", baseRef: "main", findings: [] },
    () => (++deletes === 1
      ? new Response(JSON.stringify({ error: "2 uncommitted files in the worktree.", check: fresh }), { status: 409 })
      : new Response(JSON.stringify({ ok: true, cleanupFailures: [] }), { status: 200 }))
  );
  const plain = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Archive")!;
  await act(async () => { plain.click(); await new Promise((r) => setTimeout(r, 10)); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("2 uncommitted files in the worktree.");
  const anyway = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Archive anyway");
  expect(anyway === undefined).toBe(false);
  await act(async () => { anyway!.click(); await new Promise((r) => setTimeout(r, 10)); });
  expect(calls.filter((c) => c.startsWith("DELETE ")).map((c) => c.includes("confirmed=true"))).toStrictEqual([false, true]);
});

test("when the check could not run, it says so apart from what would be lost, and Archive leaves the check to the server", async () => {
  // A failed GET is not a finding the user can confirm: the DELETE must run
  // the server's own check, whose findings then show (see the refusal test).
  const { calls } = await openArchiveDialogWithCheck(() => Response.json({ error: "git status timed out" }, { status: 502 }));
  const failed = document.querySelector('[data-slot="inline-error"]')!;
  expect(failed.textContent).toContain("Couldn't check the worktree and branch.");
  expect(failed.querySelector("p")!.textContent).toBe("git status timed out");
  expect(document.body.textContent).not.toContain("This would lose work");
  // Said in the dialog, not also in the app's banner.
  expect(useSnapshotStore.getState().banner).toBe("");
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Archive")!;
  expect(button === undefined).toBe(false);
  await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 10)); });
  const del = calls.find((c) => c.startsWith("DELETE "))!;
  expect(del).not.toContain("confirmed");
});

test("Retry runs the check again, and a clean answer clears the failure", async () => {
  let checks = 0;
  const { calls } = await openArchiveDialogWithCheck(() => (++checks === 1
    ? Response.json({ error: "git status timed out" }, { status: 502 })
    : Response.json({ dirtyFiles: 0, unmergedCommits: 0, branch: "fix-x", baseRef: "main", findings: [] })));
  const failed = document.querySelector('[data-slot="inline-error"]')!;
  const retry = Array.from(failed.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Retry")!;
  await act(async () => { retry.click(); await new Promise((r) => setTimeout(r, 10)); });
  expect(calls.filter((c) => c.includes("/archive-check")).length).toBe(2);
  expect(document.querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(document.querySelector('[role="alert"]') === null).toBe(true);
});

/** The menu for a worker with a worktree and branch of its own, archive checks answered by `check`. */
function mountArchivable(check: () => Response | Promise<Response>) {
  mockFetch(({ url, init }) => {
    if ((init?.method ?? "GET") === "GET" && url.includes("/archive-check")) return check();
    return new Response(JSON.stringify({ ok: true, cleanupFailures: [] }), { status: 200 });
  });
  const { host } = mount(
    <MemoryRouter>
      <FeatureActionsMenu featureId="f1" featureName="Alpha" featureMode="new-branch-new-worktree" branch="fix-x" hasWorktree onClose={() => {}} />
    </MemoryRouter>
  );
  return async () => {
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
    act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
    await settle();
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((n) => n.textContent?.includes("Archive"))!;
    act(() => { item.click(); });
    await settle(10);
  };
}
const dialogButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label);
const CLEAN = { dirtyFiles: 0, unmergedCommits: 0, branch: "fix-x", baseRef: "main", findings: [] };

test("Archive waits for the check to answer", async () => {
  const openDialog = mountArchivable(() => new Promise<Response>(() => {}));
  await openDialog();
  expect(document.body.textContent).toContain("Checking the worktree and branch…");
  expect(dialogButton("Archive")!.disabled).toBe(true);
});

test("reopening the dialog puts the cleanup choices back to their defaults", async () => {
  const openDialog = mountArchivable(() => Response.json(CLEAN));
  await openDialog();
  const removeWorktree = () => Array.from(document.querySelectorAll<HTMLLabelElement>("label")).find((l) => l.textContent?.includes("Remove worktree"))!.querySelector("input")!;
  expect(removeWorktree().checked).toBe(true);
  act(() => { removeWorktree().click(); });
  expect(removeWorktree().checked).toBe(false);
  act(() => { dialogButton("Cancel")!.click(); });
  await settle(10);
  await openDialog();
  expect(removeWorktree().checked).toBe(true);
});

test("a check that answers after a newer one is ignored", async () => {
  let release!: (response: Response) => void;
  let checks = 0;
  const openDialog = mountArchivable(() => (++checks === 1
    ? new Promise<Response>((resolve) => { release = resolve; })
    : Response.json(CLEAN)));
  await openDialog();
  act(() => { dialogButton("Cancel")!.click(); });
  await settle(10);
  await openDialog();
  // The first check answers last, with findings the newer one did not have.
  await act(async () => {
    release(Response.json({ ...CLEAN, dirtyFiles: 2, findings: ["2 uncommitted files in the worktree."] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await settle(10);
  expect(checks).toBe(2);
  expect(document.querySelector('[role="alert"]') === null).toBe(true);
  expect(dialogButton("Archive") === undefined).toBe(false);
});

// A manager thread says how full its context is in its header. A worker said
// it nowhere. It need not be in sight all the time (a worker compacts by
// itself at its limit), so it is a line of the worker's menu, above the
// action that answers it.
test("the worker's menu says how full its context is, above Compact now, and it is not an item", async () => {
  onCleanup(() => useAgentChatStore.setState({ threadsByScope: new Map() }));
  const measured = (featureId: string, inputTokens: number | null) => [`worker:${featureId}`, {
    ...newThreadState(), threadId: `t-${featureId}`, loaded: true,
    contextUsage: { inputTokens, budgetTokens: 250_000, updatedAt: "2026-10-13T00:00:00.000Z", source: "compression_budget" as const }
  }] as const;
  // A conversation read, as the server answers one nothing has measured yet.
  const unmeasured = ["worker:f4", { ...newThreadState(), threadId: "t-f4", loaded: true, contextUsage: null }] as const;
  useAgentChatStore.setState({ threadsByScope: new Map<string, ReturnType<typeof newThreadState>>([measured("f1", 102_000), measured("f2", 240_000), measured("f3", null), unmeasured]) });
  // The menu reads each worker's background tasks: it has none.
  mockFetch(({ url }) => (url.endsWith("/tasks") ? jsonResponse({ tasks: [] }) : jsonResponse({ error: "not served" }, 500)));
  const open = async (featureId: string) => {
    const { host, unmount } = mount(
      <MemoryRouter>
        <FeatureActionsMenu featureId={featureId} featureName="Alpha" onClose={() => {}} />
      </MemoryRouter>
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
    act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
    await settle();
    const menu = document.querySelector('[role="menu"]')!;
    const line = menu.querySelector<HTMLElement>('[data-slot="context-line"]');
    const seen = {
      says: line?.textContent ?? null,
      // What stands right after the line.
      before: line?.nextElementSibling?.textContent?.trim() ?? null,
      role: line?.getAttribute("role") ?? null,
      items: Array.from(menu.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim())
    };
    unmount();
    await settle();
    return seen;
  };
  const items = ["Refresh panes", "Compact now", "Close", "Archive worker"];
  expect(await open("f1")).toEqual({ says: "Context 41%", before: "Compact now", role: null, items });
  // Each worker's own figure.
  expect((await open("f2")).says).toBe("Context 96%");
  // Nothing measured since a compaction, nothing measured yet, or a worker
  // whose conversation this page has not read: no line.
  expect(await open("f3")).toEqual({ says: null, before: null, role: null, items });
  expect(await open("f4")).toEqual({ says: null, before: null, role: null, items });
  expect(await open("f9")).toEqual({ says: null, before: null, role: null, items });
});

const workerTask: BackgroundTaskDto = {
  id: "task_w1", kind: "subagent", parentThreadId: "thr_w", childThreadId: "thr_c_w1", type: "general", title: "0.71 retrospective",
  status: "finished", stoppedBy: null, error: null,
  createdAt: "2026-10-18T09:00:00.000Z", startedAt: "2026-10-18T09:00:05.000Z", finishedAt: "2026-10-18T09:04:17.000Z", seq: 3, exitCode: null, command: null, outputPath: null
};

/** Resets what these tests fill; registered before the mount, so the menu unmounts first. */
function resetTaskStores() {
  onCleanup(() => act(() => {
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
    resetBackgroundTasksStore();
    useCommandsStore.setState({ byScope: new Map(), noticeByScope: new Map() });
  }));
}

async function openWorkerMenu(host: HTMLElement) {
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Worker actions"]')!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

test("a worker whose conversation is not read here offers no background tasks, and asks for none", async () => {
  resetTaskStores();
  const calls = mockFetch(({ url }) => (url.endsWith("/commands") ? jsonResponse({ commands: [] }) : jsonResponse({ tasks: [workerTask] })));
  const { host } = mount(<MemoryRouter><FeatureActionsMenu featureId="f-tasks" featureName="Alpha" /></MemoryRouter>);
  const items = await openWorkerMenu(host);
  expect(items.map((n) => n.textContent?.trim())).toEqual(["Refresh panes", "Compact now", "Archive worker"]);
  expect(calls.filter((call) => call.url.includes("/tasks")).map((call) => call.url)).toStrictEqual([]);
});

test("the worker's menu offers its background tasks first once it has started one, and opens them", async () => {
  resetTaskStores();
  mockFetch(({ url }) => (url.includes("/api/agents/threads/thr_w/tasks") ? jsonResponse({ tasks: [workerTask] }) : jsonResponse({ commands: [] })));
  // Its conversation is read on the page (the worker view reads it whichever tab is open).
  act(() => useAgentChatStore.setState({ threadsByScope: new Map([["worker:f-tasks", { ...newThreadState(), threadId: "thr_w", loaded: true }]]) }));
  const { host } = mount(<MemoryRouter><FeatureActionsMenu featureId="f-tasks" featureName="Alpha" /></MemoryRouter>);
  await settleUntil(() => useBackgroundTasksStore.getState().byThread.get("thr_w")?.length === 1, "the worker's tasks were read");
  const items = await openWorkerMenu(host);
  expect(items.map((n) => n.textContent?.trim())).toEqual(["Background tasks", "Refresh panes", "Compact now", "Archive worker"]);
  await act(async () => {
    items[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  // Done ones are not counted: like messages, older ones are there to load.
  expect(document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-tasks-counts"]')?.textContent).toBe("");
  expect(document.querySelectorAll('[data-slot="background-tasks-popover"] [data-slot="background-task-row"]').length).toBe(1);
});

test("the worker's ⋯ pressed again while its list is open opens its menu alone: the list closes", async () => {
  resetTaskStores();
  mockFetch(({ url }) => (url.includes("/api/agents/threads/thr_w/tasks") ? jsonResponse({ tasks: [workerTask] }) : jsonResponse({ commands: [] })));
  act(() => useAgentChatStore.setState({ threadsByScope: new Map([["worker:f-tasks", { ...newThreadState(), threadId: "thr_w", loaded: true }]]) }));
  const { host } = mount(<MemoryRouter><FeatureActionsMenu featureId="f-tasks" featureName="Alpha" /></MemoryRouter>);
  await settleUntil(() => useBackgroundTasksStore.getState().byThread.get("thr_w")?.length === 1, "the worker's tasks were read");
  const items = await openWorkerMenu(host);
  await act(async () => {
    items[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  expect((await openWorkerMenu(host)).length).toBe(4);
  expect(document.querySelector('[data-slot="background-tasks-popover"]') === null).toBe(true);
});
