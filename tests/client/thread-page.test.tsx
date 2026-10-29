import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import { ThreadPage } from "@/routes/threads/ThreadPage";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useAgentChatStore, type AgentMessage } from "@/store/agent-chat";
import { useProjectsStore, type Feature, type Project } from "@/store/projects";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { useCommandsStore } from "@/store/commands";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { newThreadState } from "@/store/agent-chat-utils";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mount, mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { resetBackgroundTasksStore } from "../helpers/subagent-client.js";
import { clientFeature, clientProject, managerThreadDto } from "../helpers/client-builders.js";

const at = "2026-09-27T00:00:00.000Z";
let calls: string[] = [];
/** What the server lists as the thread's background tasks. */
let threadTasks: BackgroundTaskDto[] = [];

afterEach(() => {
  // Unmount before the stores the page reads are reset under it.
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
    useProjectsStore.getState().setProjectsState([]);
    useCommandsStore.setState({ byScope: new Map(), noticeByScope: new Map() });
    // A worker tab one test opened is not the next one's.
    useWorkerPanelStore.setState({ byThread: {}, maximized: null, sheet: "closed" });
    resetBackgroundTasksStore();
  });
  threadTasks = [];
});

function feature(id: string, projectId: string, ownerThreadId: string): Feature {
  return clientFeature(id, { projectId, ownerThreadId });
}

function project(id: string, name: string, features: Feature[]): Project {
  return clientProject(id, { name, workingDir: `/${name}`, tmuxSessionName: name, features });
}

const reply: AgentMessage = {
  id: "m4", threadId: "thr_a", seq: 4, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
  content: { type: "assistant", text: "Tagged v3.21." }, createdAt: at
};

/** A thread page that does not arrive while the test runs. It fails once the
 *  test is over: the chat store keeps a load in flight in a map of its own,
 *  and one that never settled would hold the next test's page back with it. */
function pageThatNeverArrives(): () => Promise<Response> {
  let fail: (reason: Error) => void = () => {};
  const page = new Promise<Response>((_, reject) => { fail = reject; });
  onCleanup(() => fail(new Error("the test is over")));
  return () => page;
}

type CommandAnswer = { taken: boolean; message: string | null };

async function renderThread(
  page: () => Promise<Response> = async () => Response.json({ thread: { id: "thr_a" }, messages: [reply], hasMore: false }),
  /** What the thread's command routes answer: the list, and each draft run. */
  commands: { list?: unknown[]; run?: (text: string) => CommandAnswer } = {}
) {
  calls = [];
  mockFetch(({ url, method, init }) => {
    calls.push(`${method} ${url} ${init?.body ?? ""}`);
    // Not the thread's page: a page that never arrives does not hold these back.
    if (url.endsWith("/commands")) {
      if (method === "GET") return Response.json({ commands: commands.list ?? [] });
      return Response.json(commands.run?.(String(JSON.parse(String(init!.body)).text)) ?? { taken: false, message: null });
    }
    // The archive dialog asks what archiving the thread's worker would lose.
    if (method === "GET" && url.includes("/archive-check")) return Response.json({ dirtyFiles: null, unmergedCommits: null, branch: null, baseRef: null, findings: [] });
    // The thread's background tasks, and a subagent's own conversation (a
    // running one's step is read from it): not the thread's page.
    if (method === "GET" && url.includes("/tasks")) return Response.json({ tasks: threadTasks });
    const child = /\/api\/agents\/threads\/(thr_c_[^/?]+)/.exec(url);
    if (method === "GET" && child) return Response.json({ thread: { id: child[1] }, messages: [], hasMore: false });
    if (method === "GET") return page();
    if (method === "PATCH") return Response.json({ thread: managerThreadDto("thr_a", { title: String(JSON.parse(String(init!.body)).title) }) });
    return Response.json({ thread: managerThreadDto("thr_a", { seenSeq: 4 }) });
  });
  act(() => {
    useManagerThreadsStore.getState().replaceAll([managerThreadDto("thr_a", { lastVisibleSeq: 4, seenSeq: 1 }), managerThreadDto("thr_b")]);
    useProjectsStore.getState().setProjectsState([
      project("p1", "project-1", [feature("parser", "p1", "thr_a")]),
      project("p2", "docs-site", [feature("typos", "p2", "thr_b")])
    ]);
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/threads/thr_a"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes><Route path="/threads/:threadId" element={<ThreadPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return host;
}

test("the thread page shows its title and the projects its own workers are in", async () => {
  const el = await renderThread();
  expect(el.querySelector('button[title="Rename"]')?.textContent).toBe("Release project-1 3.21");
  // thr_b's worker is in docs-site; it does not belong in this header.
  expect([...el.querySelectorAll('[data-slot="thread-project"]')].map((n) => n.textContent)).toEqual(["project-1"]);
});

test("opening a thread marks what it shows as seen", async () => {
  await renderThread();
  expect(useManagerThreadsStore.getState().threads.get("thr_a")!.seenSeq).toBe(4);
  expect(calls.some((c) => c.startsWith("POST /api/agents/manager/threads/thr_a/seen") && c.includes('"seq":4'))).toBe(true);
});

test("clicking the title renames the thread", async () => {
  const el = await renderThread();
  act(() => el.querySelector<HTMLButtonElement>('button[title="Rename"]')!.click());
  const input = el.querySelector<HTMLInputElement>('input[aria-label="Thread title"]')!;
  expect(input === null).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Ship project-1 3.21");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const patch = calls.find((c) => c.startsWith("PATCH "));
  expect(patch).toContain("/api/agents/manager/threads/thr_a");
  expect(patch).toContain('"title":"Ship project-1 3.21"');
  expect(useManagerThreadsStore.getState().threads.get("thr_a")!.title).toBe("Ship project-1 3.21");
});

test("an unknown thread says so once both lists have loaded", async () => {
  act(() => useManagerThreadsStore.getState().replaceAll([]));
  const { host } = mount(
    <MemoryRouter initialEntries={["/threads/thr_gone"]}>
      <Routes><Route path="/threads/:threadId" element={<ThreadPage />} /></Routes>
    </MemoryRouter>
  );
  // The archived list may still have it.
  expect(host.querySelector('[data-slot="state-message"]') === null).toBe(true);
  act(() => useManagerThreadsStore.setState({ archivedLoaded: true }));
  expect(host.querySelector('[data-slot="state-message"] h1')?.textContent).toBe("Thread not found");
  expect(host.textContent).toContain("It was deleted, or the link is wrong.");
  const back = host.querySelector<HTMLAnchorElement>('[data-slot="state-message"] a')!;
  expect(back.textContent).toBe("Back to Home");
  expect(back.getAttribute("href")).toBe("/home");
});

test("a live row arriving while the transcript loads does not mark the thread seen", async () => {
  await renderThread(pageThatNeverArrives());
  // As a load in flight leaves it: the id bound, no page yet.
  act(() => useAgentChatStore.setState((s) => ({
    threadsByScope: new Map(s.threadsByScope).set("manager:thr_a", { ...newThreadState(), threadId: "thr_a" })
  })));
  // The stream delivers a reply before the page does.
  act(() => useAgentChatStore.getState().onMessageAppended("thr_a", reply));
  expect(useAgentChatStore.getState().threadsByScope.get("manager:thr_a")!.messages.length).toBe(1);
  expect(useManagerThreadsStore.getState().threads.get("thr_a")!.seenSeq).toBe(1);
  expect(calls.some((c) => c.startsWith("POST "))).toBe(false);
});

test("a phone's sheet does not outlive the phone layout", async () => {
  act(() => useWorkerPanelStore.setState({ sheet: "full" }));
  try {
    await renderThread();
    expect(useWorkerPanelStore.getState().sheet).toBe("closed");
  } finally {
    act(() => useWorkerPanelStore.setState({ byThread: {}, maximized: null, sheet: "closed" }));
  }
});

// The thread's menu was the one ⋯ menu without icons, its archive red by
// hand; it reads like the worker's: an icon per item, the
// archive the menu's own destructive item.
test("the thread menu's items carry icons, and its archive is the menu's destructive item", async () => {
  await renderThread();
  const trigger = document.querySelector<HTMLElement>('[aria-label="Thread actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((n) => n.textContent)).toEqual(["Rename", "Compact now", "Archive thread"]);
  for (const item of items) expect(item.querySelector("svg")).not.toBeNull();
  expect(items[2]!.getAttribute("data-variant")).toBe("destructive");
});

test("archiving a thread asks first, naming it; Cancel keeps it", async () => {
  await renderThread();
  const menuItem = async (label: string) => {
    const trigger = document.querySelector<HTMLElement>('[aria-label="Thread actions"]')!;
    await act(async () => {
      trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((n) => n.textContent === label)!;
    await act(async () => { item.click(); await new Promise((r) => setTimeout(r, 0)); });
  };
  const dialogButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label)!;
  const archived = () => calls.filter((c) => c.startsWith("PATCH ") && c.includes('"archived":true'));

  await menuItem("Archive thread");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Release project-1 3.21");
  expect(archived()).toEqual([]);
  await act(async () => { dialogButton("Cancel").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(archived()).toEqual([]);

  await menuItem("Archive thread");
  await act(async () => { dialogButton("Archive").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(archived().length).toBe(1);
});

const COMMANDS = [
  { name: "/compact", description: "Summarize earlier messages to free up context", blocked: { running: "A turn is running", compacting: "Already compacting" } },
  { name: "/stop", description: "Stop the running turn", blocked: { idle: "Nothing is running", compacting: "A compaction can't be stopped" } },
  { name: "/context", description: "Show how much context is in use", blocked: {} }
];

/** The thread page with its command routes answered: `run` gets each posted draft. */
async function renderWithCommands(run: (text: string) => CommandAnswer) {
  const posted: string[] = [];
  const host = await renderThread(undefined, { list: COMMANDS, run: (text) => { posted.push(text); return run(text); } });
  const textarea = host.querySelector("textarea")!;
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!.call(textarea, text);
      textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    });
  };
  const enter = async () => {
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
  };
  const notice = () => host.querySelector('[data-slot="command-notice"]')?.textContent ?? null;
  return { host, textarea, type, enter, notice, posted };
}

test("a command typed in a thread goes to its command route, and what it answers stands above the composer until the next keystroke", async () => {
  const c = await renderWithCommands(() => ({ taken: true, message: "Context: 34.2k of 250.0k tokens" }));
  expect(c.notice()).toBe(null);
  await c.type("/context");
  await c.enter();
  expect(c.posted).toStrictEqual(["/context"]);
  expect(calls.some((line) => line.startsWith("POST /api/agents/threads/thr_a/commands") && line.includes('"attachments":0'))).toBe(true);
  // Not a message: nothing went to the message route.
  expect(calls.some((line) => line.startsWith("POST /api/agents/threads/thr_a/messages"))).toBe(false);
  expect(c.notice()).toBe("Context: 34.2k of 250.0k tokens");
  expect(c.textarea.value).toBe("");
  await c.type("h");
  expect(c.notice()).toBe(null);
});

test("a refusal stands above the composer with the draft still in it, and can be dismissed", async () => {
  const c = await renderWithCommands(() => ({ taken: false, message: "A turn is running. Try again when it finishes." }));
  await c.type("/compact");
  await c.enter();
  expect([c.notice(), c.textarea.value]).toEqual(["A turn is running. Try again when it finishes.", "/compact"]);
  await act(async () => { c.host.querySelector<HTMLElement>('[data-slot="command-notice"] [aria-label="Dismiss"]')!.click(); });
  expect(c.notice()).toBe(null);
});

test("a command with nothing to say leaves no line", async () => {
  const c = await renderWithCommands(() => ({ taken: true, message: null }));
  await c.type("/compact");
  await c.enter();
  expect([c.posted, c.notice(), c.textarea.value]).toEqual([["/compact"], null, ""]);
});

test("the list greys what the thread cannot run now", async () => {
  const c = await renderWithCommands(() => ({ taken: false, message: null }));
  act(() => {
    const store = useAgentChatStore.getState();
    const entry = store.threadsByScope.get("manager:thr_a")!;
    useAgentChatStore.setState({ threadsByScope: new Map(store.threadsByScope).set("manager:thr_a", { ...entry, wakePhase: { wakeId: "w9", phase: "thinking", startedAt: at } }) });
  });
  await c.type("/");
  const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="command-list"] [role="option"]')];
  // A turn is running: no compaction, and something to stop.
  expect(rows.map((row) => [row.children[0]!.textContent, row.hasAttribute("data-blocked")])).toEqual([["/compact", true], ["/stop", false], ["/context", false]]);
});

test("the first load keeps its spinner when a live row lands before the page does", async () => {
  const el = await renderThread(pageThatNeverArrives());
  act(() => useAgentChatStore.setState((s) => ({
    threadsByScope: new Map(s.threadsByScope).set("manager:thr_a", { ...newThreadState(), threadId: "thr_a" })
  })));
  act(() => useAgentChatStore.getState().onMessageAppended("thr_a", reply));
  // Earlier history has not arrived: showing one reply as the transcript would mislead.
  expect(el.textContent).toContain("Loading…");
  expect(el.textContent).not.toContain("Tagged v3.21.");
});

const openThreadMenu = async () => {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Thread actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
};
/** Collects what the menu's command says: a menu answers with a toast. */
function toasts(): string[] {
  const shown: string[] = [];
  const original = toast.message;
  toast.message = ((message: unknown) => { shown.push(String(message)); return 0; }) as typeof toast.message;
  onCleanup(() => { toast.message = original; });
  return shown;
}

test("the thread's menu compacts now: the same command, its answer as a toast", async () => {
  const shown = toasts();
  const c = await renderWithCommands(() => ({ taken: true, message: "Nothing to compact yet." }));

  const items = await openThreadMenu();
  const item = items.find((n) => n.textContent === "Compact now")!;
  expect(item.hasAttribute("data-disabled")).toBe(false);
  await act(async () => { item.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(c.posted).toStrictEqual(["/compact"]);
  expect(shown).toStrictEqual(["Nothing to compact yet."]);
  // A menu's answer is a toast; the composer's line is for what was typed.
  expect(c.notice()).toBe(null);
});

test("Compact now says the compaction has started, in the working line's words, and is greyed while a turn runs", async () => {
  const shown = toasts();
  const c = await renderWithCommands(() => ({ taken: true, message: null }));
  await act(async () => { (await openThreadMenu())[1]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  // Taken, with nothing to answer: it has started. The menu says so itself.
  expect([c.posted, shown]).toEqual([["/compact"], ["Compacting context…"]]);

  act(() => {
    const store = useAgentChatStore.getState();
    const entry = store.threadsByScope.get("manager:thr_a")!;
    useAgentChatStore.setState({ threadsByScope: new Map(store.threadsByScope).set("manager:thr_a", { ...entry, wakePhase: { wakeId: "w9", phase: "thinking", startedAt: at } }) });
  });
  const item = (await openThreadMenu())[1]!;
  expect([item.textContent, item.hasAttribute("data-disabled")]).toEqual(["Compact now", true]);
});

const ARCHIVED_AT = "2026-10-13T09:00:00.000Z";

/** thr_a archived, with its conversation and two archived workers; thr_b open. */
async function renderArchived(
  deleteAnswer: () => Response = () => Response.json({ ok: true, deleted: { threads: 3, workers: 2, canvases: 1 } }),
  messages: AgentMessage[] = [reply]
) {
  calls = [];
  mockFetch(({ url, method, init }) => {
    calls.push(`${method} ${url} ${init?.body ?? ""}`);
    if (method === "DELETE") return deleteAnswer();
    if (url.includes("/workers?archived=1")) {
      return Response.json({ workers: [
        { featureId: "parser", name: "Parser rewrite", projectId: "p1", projectName: "project-1", archivedAt: ARCHIVED_AT, workerThreadId: "thr_w1" },
        { featureId: "docs", name: "Docs pass", projectId: "p1", projectName: "project-1", archivedAt: ARCHIVED_AT, workerThreadId: "thr_w2" }
      ] });
    }
    if (url.includes("?archived=1")) return Response.json({ archived: [] });
    // What its last turn measured: an archived thread shows no context figure.
    return Response.json({
      thread: { id: "thr_a" }, messages, hasMore: false,
      contextUsage: { inputTokens: 34_000, budgetTokens: 100_000, updatedAt: at, source: "compression_budget" }
    });
  });
  act(() => {
    useManagerThreadsStore.getState().replaceAll([managerThreadDto("thr_b")]);
    useManagerThreadsStore.setState({
      archived: [{ id: "thr_a", title: "Release project-1 3.21", archivedAt: ARCHIVED_AT, workers: 2, canvases: 1 }],
      archivedLoaded: true
    });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/threads/thr_a"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes>
          <Route path="/threads/:threadId" element={<ThreadPage />} />
          <Route path="/home" element={<p data-slot="home">Home</p>} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return host;
}

async function openMenu() {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Thread actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

test("an archived thread opens read-only: its title and when it was archived, its conversation, a note where the composer was", async () => {
  const host = await renderArchived();
  expect(host.querySelector('[data-slot="archived-title"]')?.textContent).toBe("Release project-1 3.21");
  expect(host.querySelector('[data-slot="archived-date"]')?.textContent).toBe("Archived Oct 13");
  // Nothing to rename.
  expect(host.querySelector('button[title="Rename"]') === null).toBe(true);
  expect(host.textContent).toContain("Tagged v3.21.");
  expect(host.querySelector("textarea") === null).toBe(true);
  expect(host.querySelector('[data-slot="archived-note"]')?.textContent).toBe("Archived on Oct 13. You can read it here; nothing more can be sent.");
  expect(useAgentChatStore.getState().threadsByScope.get("manager:thr_a")?.contextUsage?.inputTokens).toBe(34_000);
  expect(host.querySelector('[aria-label^="Last successful agent call used"]') === null).toBe(true);
  // Not marked seen, no commands asked for: nothing is sent to it.
  expect(calls.filter((c) => c.startsWith("POST ") || c.includes("/commands"))).toStrictEqual([]);
  const items = await openMenu();
  expect(items.map((n) => n.textContent)).toEqual(["Delete permanently…"]);
  expect(items[0]!.getAttribute("data-variant")).toBe("destructive");
});

test("deleting an archived thread asks first, listing what goes; Cancel keeps it, Delete sends it and goes Home", async () => {
  const host = await renderArchived();
  const choose = async () => {
    const item = (await openMenu()).find((n) => n.textContent === "Delete permanently…")!;
    await act(async () => { item.click(); await new Promise((r) => setTimeout(r, 0)); });
  };
  const dialogButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label)!;
  const deletes = () => calls.filter((c) => c.startsWith("DELETE "));
  await choose();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector("h2")!.textContent).toBe("Delete “Release project-1 3.21” permanently?");
  expect([...dialog.querySelectorAll('[data-slot="delete-list"] li')].map((li) => li.textContent)).toEqual([
    "the thread’s conversation", "its 2 workers, with their chats and plans", "1 canvas"
  ]);
  expect(dialog.textContent).toContain("Worktrees and branches still on disk are left as they are. This can’t be undone.");
  await act(async () => { dialogButton("Cancel").click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(deletes()).toEqual([]);
  await choose();
  await act(async () => { dialogButton("Delete permanently").click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(deletes().map((c) => c.split(" ")[1])).toEqual(["/api/agents/manager/threads/thr_a"]);
  expect(host.querySelector('[data-slot="home"]')).not.toBeNull();
  expect(useManagerThreadsStore.getState().archived).toEqual([]);
});

test("a delete refused stays on the page and says why", async () => {
  const errors: string[] = [];
  const original = toast.error;
  toast.error = ((message: string) => { errors.push(message); return 0; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  const host = await renderArchived(() => Response.json({ error: "Its work is still stopping. Try again in a moment." }, { status: 409 }));
  const item = (await openMenu()).find((n) => n.textContent === "Delete permanently…")!;
  await act(async () => { item.click(); await new Promise((r) => setTimeout(r, 0)); });
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Delete permanently")!;
  await act(async () => { button.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(errors).toStrictEqual(["Its work is still stopping. Try again in a moment."]);
  expect(host.querySelector('[data-slot="home"]') === null).toBe(true);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

test("an archived thread's Workers lists the workers it had, each opening read-only", async () => {
  const host = await renderArchived();
  const toggle = host.querySelector<HTMLButtonElement>('[data-slot="panel-toggle"]')!;
  expect([toggle.textContent, toggle.getAttribute("aria-label")]).toEqual(["Panel", "Show panel"]);
  await act(async () => { toggle.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  const panel = host.querySelector<HTMLElement>('[data-slot="worker-panel"]')!;
  // The count is of the workers it had.
  expect(panel.querySelector('[role="tablist"] button, [role="tablist"] [role="tab"]')?.textContent).toBe("Workers2");
  expect(panel.textContent).not.toContain("No active workers");
  const archived = [...panel.querySelectorAll<HTMLElement>('section[aria-label="Archived"] button')];
  expect(archived.map((b) => b.textContent)).toEqual(["Parser rewriteproject-1", "Docs passproject-1"]);
  // One opens as an archived worker does: its tabs and nothing to send with.
  await act(async () => { archived[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(panel.querySelector('[data-worker-tab="archived:parser"]')?.getAttribute("aria-selected")).toBe("true");
  expect([...panel.querySelectorAll('[role="tablist"]:not([aria-label="Worker tabs"]) [role="tab"]')].map((t) => t.textContent)).toEqual(["Chat", "Plan", "Canvases"]);
  expect(panel.querySelector("textarea") === null).toBe(true);
});

test("a thread archived while its page is open stays on screen, read-only", async () => {
  const host = await renderThread();
  expect(host.querySelector("textarea")).not.toBeNull();
  act(() => useManagerThreadsStore.getState().upsert(managerThreadDto("thr_a", { archivedAt: ARCHIVED_AT })));
  await settle();
  expect(host.querySelector("textarea") === null).toBe(true);
  expect(host.querySelector('[data-slot="archived-note"]')?.textContent).toBe("Archived on Oct 13. You can read it here; nothing more can be sent.");
  expect(host.textContent).toContain("Tagged v3.21.");
});

test("a turn an archived thread stopped on offers no Continue", async () => {
  const stopped: AgentMessage = {
    id: "f1", threadId: "thr_a", seq: 5, role: "system", source: "wake-failure", sourceThreadId: null, wakeId: "w1", createdAt: at,
    content: { type: "wake_failure", status: "limit_reached", message: null, stepCount: 60 } as never
  };
  const host = await renderArchived(undefined, [reply, stopped]);
  expect(host.querySelector('[data-slot="wake-failure"]')).not.toBeNull();
  expect(host.querySelectorAll('[data-slot="wake-failure"] button')).toHaveLength(0);
});

test("a message that failed to send before the thread was archived offers no Retry there", async () => {
  const host = await renderArchived();
  act(() => useAgentChatStore.setState((s) => {
    const current = s.threadsByScope.get("manager:thr_a")!;
    const pendingUserMessages = new Map(current.pendingUserMessages).set("local-1", {
      localId: "local-1", content: "Tag it now.", status: "failed", createdAt: at, error: "Network error"
    });
    return { threadsByScope: new Map(s.threadsByScope).set("manager:thr_a", { ...current, pendingUserMessages }) };
  }));
  await settle();
  expect(host.textContent).toContain("Tag it now.");
  expect(host.textContent).toContain("Network error");
  expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Retry").length).toBe(0);
});

test("a thread not open, with the archived list's read failed, says it could not be loaded and reads again on Retry", async () => {
  const calls = mockFetch(({ url }) => url.endsWith("?archived=1")
    ? Response.json({ archived: [{ id: "thr_old", title: "project-1 cache expiry", archivedAt: ARCHIVED_AT, workers: 0, canvases: 0 }] })
    : Response.json({ thread: { id: "thr_old" }, messages: [], hasMore: false }));
  act(() => {
    useManagerThreadsStore.getState().replaceAll([]);
    useManagerThreadsStore.setState({ archivedReadFailed: true });
  });
  const { host } = mount(
    <MemoryRouter initialEntries={["/threads/thr_old"]}>
      <Routes><Route path="/threads/:threadId" element={<ThreadPage />} /></Routes>
    </MemoryRouter>
  );
  expect(host.querySelector('[data-slot="state-message"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="inline-error"]')?.textContent).toContain("Couldn't load the thread.");
  const retry = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="inline-error"] button')].find((b) => b.textContent === "Retry")!;
  await act(async () => { retry.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settle();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toContain("GET /api/agents/manager/threads?archived=1");
  expect(host.querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="archived-note"]')).not.toBeNull();
});

test("a later read of the archived list that failed is said so too, though an earlier one answered", () => {
  act(() => {
    useManagerThreadsStore.getState().replaceAll([]);
    // Read once without it; archived elsewhere while this tab was away; the read on reconnect failed.
    useManagerThreadsStore.setState({ archived: [], archivedLoaded: true, archivedReadFailed: true });
  });
  const { host } = mount(
    <MemoryRouter initialEntries={["/threads/thr_old"]}>
      <Routes><Route path="/threads/:threadId" element={<ThreadPage />} /></Routes>
    </MemoryRouter>
  );
  expect(host.querySelector('[data-slot="state-message"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="inline-error"]')?.textContent).toContain("Couldn't load the thread.");
});

test("a worker tab left open from before the archive opens read-only, though the page has not yet heard its worker was archived", async () => {
  // The worker as the page still holds it: live, owned by the thread.
  act(() => {
    useProjectsStore.getState().setProjectsState([project("p1", "project-1", [feature("parser", "p1", "thr_a")])]);
    useWorkerPanelStore.getState().setOpen("thr_a", true);
    useWorkerPanelStore.getState().openWorker("thr_a", "parser");
  });
  const host = await renderArchived();
  await settle();
  const panel = host.querySelector<HTMLElement>('[data-slot="worker-panel"]')!;
  expect([...panel.querySelectorAll('[role="tablist"]:not([aria-label="Worker tabs"]) [role="tab"]')].map((t) => t.textContent)).toEqual(["Chat", "Plan", "Canvases"]);
  expect(panel.querySelector("textarea") === null).toBe(true);
});

const bgTask = (id: string, patch: Partial<BackgroundTaskDto>): BackgroundTaskDto => ({
  id, kind: "subagent", parentThreadId: "thr_a", childThreadId: `thr_c_${id}`, type: "general", title: id,
  status: "running", stoppedBy: null, error: null,
  createdAt: at, startedAt: at, finishedAt: null, seq: patch.status === "running" || patch.status === undefined ? 2 : patch.status === "queued" ? 1 : 3, exitCode: null, command: null, outputPath: null, ...patch
});

test("the thread menu's first item is its background tasks, with how many it started; it opens the list under the ⋯", async () => {
  threadTasks = [
    bgTask("task_run", { title: "Find the retry call sites" }),
    bgTask("task_done", { title: "0.71 retrospective", status: "finished", finishedAt: at })
  ];
  await renderThread();
  // Read from the server as the page opened: nothing was put in the store by hand.
  await settleUntil(() => useBackgroundTasksStore.getState().byThread.get("thr_a")?.length === 2, "the thread's tasks were read");
  const items = await openThreadMenu();
  expect(items.map((n) => n.textContent)).toEqual(["Background tasks", "Rename", "Compact now", "Archive thread"]);
  expect(items[0]!.querySelector("svg") === null).toBe(false);
  await act(async () => {
    items[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  const popover = document.querySelector<HTMLElement>('[data-slot="background-tasks-popover"]')!;
  expect(popover.querySelector('[data-slot="background-tasks-counts"]')?.textContent).toBe("1 running");
  expect([...popover.querySelectorAll('[data-slot="background-tasks-section"]')].map((s) => s.getAttribute("data-section"))).toEqual(["running", "done"]);
});

/** Opens the thread's list from its ⋯ (its first item), and waits for it. */
async function openTaskList() {
  const items = await openThreadMenu();
  await act(async () => {
    items[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
}

test("the ⋯ pressed again while its list is open opens its menu alone: the list closes", async () => {
  threadTasks = [bgTask("task_done", { title: "0.71 retrospective", status: "finished", finishedAt: at })];
  await renderThread();
  await settleUntil(() => useBackgroundTasksStore.getState().byThread.get("thr_a")?.length === 1, "the thread's tasks were read");
  await openTaskList();
  const items = await openThreadMenu();
  expect(items.map((n) => n.textContent)).toEqual(["Background tasks", "Rename", "Compact now", "Archive thread"]);
  expect(document.querySelector('[data-slot="background-tasks-popover"]') === null).toBe(true);
});

test("Esc in the list closes it and gives focus back to the ⋯ it opened from", async () => {
  threadTasks = [bgTask("task_done", { title: "0.71 retrospective", status: "finished", finishedAt: at })];
  await renderThread();
  await settleUntil(() => useBackgroundTasksStore.getState().byThread.get("thr_a")?.length === 1, "the thread's tasks were read");
  await openTaskList();
  const row = document.querySelector<HTMLElement>('[data-slot="background-tasks-popover"] [data-slot="background-task-row"]')!;
  act(() => row.focus());
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') === null, "the list closed");
  // Radix gives focus back a tick after the popover has gone.
  await settleUntil(() => document.activeElement?.getAttribute("aria-label") === "Thread actions", "focus back on the ⋯");
});

test("the strip's folded row of the thread's subagents opens the same list, and closes it again", async () => {
  threadTasks = [bgTask("task_a", { title: "Upgrade guide for 0.72" }), bgTask("task_b", { title: "API changes since 0.71" })];
  await renderThread();
  const folded = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="worker-strip"] button')].find((b) => b.textContent?.includes("2 subagents"));
  await settleUntil(() => folded() !== undefined, "the folded row");
  expect([folded()!.getAttribute("aria-haspopup"), folded()!.getAttribute("aria-expanded")]).toEqual(["dialog", "false"]);
  await act(async () => {
    folded()!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  expect(document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-tasks-counts"]')?.textContent).toBe("2 running");
  expect(folded()!.getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    folded()!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') === null, "the list closed");
});
