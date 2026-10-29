import { afterEach, expect, test } from "bun:test";
import { act, StrictMode, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { ThreadPage } from "@/routes/threads/ThreadPage";
import { TopBar } from "@/shell/TopBar";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useAgentChatStore } from "@/store/agent-chat";
import { useProjectsStore, type Feature } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { emptyPlan } from "@shared/api/plans";
import { useWorkerPanelStore } from "@/store/worker-panel";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { WorkItemDto } from "@shared/api/work-items";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { clientFeature, clientProject, managerThreadDto } from "../helpers/client-builders.js";

const at = "2026-09-27T00:00:00.000Z";
let url = "";
/** What the thread's transcript holds, as the server answers it. */
let transcript: unknown[] = [];

afterEach(() => {
  // Unmount before the stores the page reads are reset under it.
  runCleanups();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
    useProjectsStore.getState().setProjectsState([]);
    useWorkItemsStore.setState({ items: new Map() });
    useWorkerPanelStore.setState({ byThread: {}, maximized: null, sheet: "closed" });
  });
  transcript = [];
});

const thread = managerThreadDto("thr_a", { title: "project-1 3.21 release" });
const w1 = clientFeature("w1");
const project = clientProject("p1", { features: [w1] });
const item: WorkItemDto = {
  id: "wi-w1", featureId: "w1", projectId: "p1", title: "w1",
  lastActivityAt: at, createdAt: at, updatedAt: at, failedAt: null, failedMessage: null, failedKind: null
};

let step = false;
let go: (to: string | number) => void = () => {};
function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  url = location.pathname + location.search;
  // Whether this entry is the sheet's step in the history.
  step = (location.state as { workerSheet?: boolean } | null)?.workerSheet === true;
  go = (to) => (typeof to === "number" ? navigate(to) : navigate(to));
  return null;
}

/** The thread, reached from Home: Back from it has somewhere to go. */
async function render(
  path: string | { pathname: string; state: unknown } = "/threads/thr_a",
  { phone = true, strict = false, panel }: { phone?: boolean; strict?: boolean; panel?: ReturnType<typeof useWorkerPanelStore.getState>["byThread"] } = {}
) {
  // As main.tsx mounts the app in development: effects run, are undone, and run again.
  const Mode = strict ? StrictMode : ({ children }: { children: ReactNode }) => <>{children}</>;
  // A step is always on top of its thread's own entry: that is what added it.
  const entries = typeof path === "string" ? ["/home", path] : ["/home", path.pathname, path];
  if (phone) onCleanup(fakePhoneWidth());
  mockFetch((call) => {
    if (call.url.includes("/canvases")) return Response.json({ canvases: [] });
    // The thread's background tasks: none.
    if (call.url.endsWith("/tasks")) return Response.json({ tasks: [] });
    if (call.url.includes("/workers?archived=1")) return Response.json({ workers: [] });
    return Response.json({ thread: { id: "thr_a" }, messages: transcript, hasMore: false });
  });
  act(() => {
    // Other suites leave panel state behind; this one starts clean.
    useWorkerPanelStore.setState({ byThread: panel ?? {}, maximized: null, sheet: "closed" });
    useManagerThreadsStore.getState().replaceAll([thread]);
    useProjectsStore.getState().setProjectsState([project]);
    useWorkItemsStore.getState().upsert(item);
    // w1 asks: a question in its plan, and no flag.
    useFeaturePlansStore.getState().upsert({ ...emptyPlan("w1"), openQuestions: ["Keep the old flag as an alias?"], updatedAt: at }, "fetch");
  });
  const { host } = await mountAsync(
    <Mode>
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <PaneHeaderSlotsProvider>
        <TopBar />
        <Routes>
          <Route path="/home" element={<p data-testid="home">home</p>} />
          <Route path="/threads/:threadId" element={<ThreadPage />} />
        </Routes>
        <Where />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
    </Mode>
  );
  await settle();
  return host;
}

const sheet = () => document.querySelector<HTMLElement>('[data-slot="worker-sheet"]');

test("phone: the panel is a sheet; opening a worker pulls it to full", async () => {
  const el = await render();
  expect(document.querySelector('[data-slot="worker-panel-side"]') === null).toBe(true);
  // The thread's title is the top bar's; no split, no maximize, no hide.
  expect(el.querySelector('header')?.textContent).toContain("project-1 3.21 release");
  expect(document.querySelector('[aria-label="Hide panel"]') === null).toBe(true);
  expect(document.querySelector('[data-pane-zoom]') === null).toBe(true);
  const workers = el.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')!;
  expect(workers === null).toBe(false);
  await act(async () => { workers.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(sheet()?.getAttribute("data-expanded")).toBe("false");
  const row = sheet()!.querySelector<HTMLButtonElement>('[data-worker="w1"]')!;
  await act(async () => { row.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(sheet()?.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
  expect(sheet()?.querySelector('[data-slot="worker-panel-sheet"]') === null).toBe(false);
  expect(document.querySelector('[aria-label="Hide panel"]') === null).toBe(true);
});

test("phone: ?worker= opens the sheet at full height on that worker, and stays on the thread", async () => {
  await render("/threads/thr_a?worker=w1");
  expect(url).toBe("/threads/thr_a");
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
  // Waiting for an answer: its Chat tab.
  const selected = sheet()?.querySelector('[data-slot="worker-panel-sheet"] [role="tablist"]:not([aria-label]) [aria-selected="true"]');
  expect(selected?.textContent).toBe("Chat");
});

test("phone: picking an open worker's tab in a half-height sheet brings it to full", async () => {
  await render("/threads/thr_a?worker=w1");
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
  // Pulled down to half, back on the Workers tab.
  act(() => {
    useWorkerPanelStore.getState().setSheet("half");
    useWorkerPanelStore.getState().setActive("thr_a", "workers");
  });
  expect(sheet()?.getAttribute("data-expanded")).toBe("false");
  const tab = sheet()!.querySelector<HTMLElement>('[data-worker-tab="w1"]')!;
  await act(async () => { tab.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
});

test("phone: the sheet's Workers tab is its only visible title", async () => {
  const el = await render();
  const workers = el.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')!;
  await act(async () => { workers.click(); await new Promise((r) => setTimeout(r, 0)); });
  // The dialog is still named Workers, for a screen reader; the tab row under
  // it already says so on screen.
  const title = [...sheet()!.querySelectorAll("h2")].find((h) => h.textContent === "Workers")!;
  expect(title.className).toContain("sr-only");
  expect(sheet()!.getAttribute("aria-labelledby")).toBe(title.id);
});

// Opened from Home's waiting row (?worker=) the sheet fills the screen, and
// its only ways out were the drag handle and an 8px strip above it. Its
// header ends in a 44px Close, as the tool-calls sheet's does.
test("phone: the worker sheet's header has a Close that closes the sheet", async () => {
  await render("/threads/thr_a?worker=w1");
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
  const close = sheet()!.querySelector<HTMLButtonElement>('[data-slot="worker-panel-sheet"] button[aria-label="Close"]')!;
  expect(close === null).toBe(false);
  expect(close.className.split(/\s+/)).toContain("size-11");
  await act(async () => { close.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(useWorkerPanelStore.getState().sheet).toBe("closed");
});

// ── Back closes the sheet first ─────────────────────────────
// The sheet was not a step in the history: with it open, the phone's Back
// left the thread. Opening it now adds a step for the same address, Back
// takes that step and the sheet closes, and a sheet closed any other way
// takes its step back itself, so no Back is left that does nothing.

// vaul keeps a closing sheet in the document for its slide out, which never
// ends without layout: closed is what the sheet says, not its absence.
const sheetShown = () => sheet() !== null && sheet()!.getAttribute("data-state") !== "closed";
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const back = async () => { await act(async () => { go(-1); }); await settle(); await tick(); };
const openWorkers = async (el: HTMLElement) => {
  await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')!.click(); });
  await settle(); await tick();
};

test("phone: opening the sheet adds a step; Back closes the sheet and stays on the thread; the next Back leaves it", async () => {
  const el = await render();
  expect(step).toBe(false);
  await openWorkers(el);
  expect(sheetShown()).toBe(true);
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: true });
  await back();
  expect(sheetShown()).toBe(false);
  expect(useWorkerPanelStore.getState().sheet).toBe("closed");
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: false });
  await back();
  expect(url).toBe("/home");
});

test("phone: a sheet closed with its Close takes its step back, so one Back leaves the thread", async () => {
  const el = await render();
  await openWorkers(el);
  expect(step).toBe(true);
  const close = sheet()!.querySelector<HTMLButtonElement>('[data-slot="worker-panel-sheet"] button[aria-label="Close"]')!;
  await act(async () => { close.click(); });
  await settle(); await tick();
  expect(sheetShown()).toBe(false);
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: false });
  await back();
  expect(url).toBe("/home");
});

test("phone: a worker opened by ?worker= is a step too, for the address without it", async () => {
  await render("/threads/thr_a?worker=w1");
  // Each navigation can take more turns than a fixed count on a busy machine.
  await settleUntil(() => sheetFull() && url === "/threads/thr_a" && step, "the sheet open at full, the address without ?worker=");
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: true });
  await back();
  // The thread itself, not ?worker= again: the worker does not reopen.
  await settleUntil(() => !sheetShown() && !step, "the sheet closed onto the thread");
  expect(sheetShown()).toBe(false);
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: false });
  await back();
  await settleUntil(() => url === "/home", "Home");
  expect(url).toBe("/home");
});

const sheetFull = () => sheet()?.getAttribute("data-expanded") === "true";

test("phone: Back to a step from another page opens the sheet as it was left", async () => {
  await render("/threads/thr_a?worker=w1");
  // The address letting go of ?worker= is a router navigation: it can take
  // more turns than a fixed count on a busy machine.
  await settleUntil(sheetFull, "the sheet to open at full on the worker");
  // A link in the sheet led elsewhere.
  await act(async () => { go("/home"); });
  await settleUntil(() => url === "/home" && useWorkerPanelStore.getState().sheet === "closed", "Home, the sheet closed");
  expect(url).toBe("/home");
  expect(useWorkerPanelStore.getState().sheet).toBe("closed");
  await back();
  await settleUntil(sheetFull, "the sheet to open at full again on the step");
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: true });
  expect(sheet()?.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
  // And Back from there closes it, onto the thread.
  await back();
  await settleUntil(() => !sheetShown() && !step, "the sheet closed onto the thread");
  expect(sheetShown()).toBe(false);
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: false });
});

test("a wide screen opens a worker in its panel and adds no step", async () => {
  await render("/threads/thr_a?worker=w1", { phone: false });
  await tick();
  expect(sheetShown()).toBe(false);
  expect(document.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: false });
  await back();
  expect(url).toBe("/home");
});

// main.tsx mounts the app in StrictMode: on mount React runs every effect,
// undoes it and runs it again. Arriving on a step (a reload, Back from another
// page) must come out the same: the sheet open, the entry still there.
test("phone, StrictMode: arriving on a step opens the sheet and keeps the entry", async () => {
  await render({ pathname: "/threads/thr_a", state: { workerSheet: true } }, { strict: true });
  await tick();
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: true });
  expect(sheetShown()).toBe(true);
  // Nothing remembered of this thread's panel (a fresh page): the list, at half.
  expect(sheet()?.getAttribute("data-expanded")).toBe("false");
  await back();
  expect(sheetShown()).toBe(false);
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: false });
});

// A wide window left a report's tab open; the sheet shows no canvas tabs, so
// arriving on its step (a reload, Back) shows the Workers list, at half height
// as the list opens, not at a worker's full height.
test("phone: arriving on a step with a canvas tab left open shows the Workers list at half height", async () => {
  await render({ pathname: "/threads/thr_a", state: { workerSheet: true } }, {
    panel: { thr_a: { open: true, tabs: ["w1", `canvas:${CANVAS}`], active: `canvas:${CANVAS}`, workerTab: {} } }
  });
  await tick();
  expect(sheetShown()).toBe(true);
  expect(sheet()!.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("Workers");
  expect(sheet()?.getAttribute("data-expanded")).toBe("false");
});

// A worker that moved shows "Open it in its thread": a link from one thread's
// open sheet to another thread's ?worker= address. The sheet's state is shared
// and still says open while the new thread first draws; the new thread must
// not take it for its own and add a step before the parameter is gone.
test("phone: from one thread's open sheet to another thread's ?worker=, each thread has its own step", async () => {
  const el = await render();
  const threadB: ManagerThreadDto = { ...thread, id: "thr_b", title: "project-2" };
  const w2: Feature = { ...w1, id: "w2", name: "w2", tmuxWindowName: "w2", ownerThreadId: "thr_b" };
  act(() => {
    useManagerThreadsStore.getState().replaceAll([thread, threadB]);
    useProjectsStore.getState().setProjectsState([{ ...project, features: [w1, w2] }]);
  });
  await openWorkers(el);
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: true });

  await act(async () => { go("/threads/thr_b?worker=w2"); });
  await settle(); await tick(); await tick();
  expect({ url, step }).toEqual({ url: "/threads/thr_b", step: true });
  expect(sheet()?.querySelector('[data-worker-tab="w2"]')?.getAttribute("aria-selected")).toBe("true");

  // Back closes thread B's sheet onto thread B, without ?worker= again.
  await back();
  expect(sheetShown()).toBe(false);
  expect({ url, step }).toEqual({ url: "/threads/thr_b", step: false });
  // Then thread A's step: its sheet, as it was left.
  await back();
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: true });
  expect(sheetShown()).toBe(true);
  await back();
  expect({ url, step }).toEqual({ url: "/threads/thr_a", step: false });
  await back();
  expect(url).toBe("/home");
});

test("phone: an archived thread's title is the top bar's, the note stands where the composer was, and Workers counts the ones it had", async () => {
  onCleanup(fakePhoneWidth());
  mockFetch(({ url }) => (url.endsWith("/tasks") ? Response.json({ tasks: [] }) : Response.json({ thread: { id: "thr_old" }, messages: [], hasMore: false })));
  act(() => {
    useManagerThreadsStore.getState().replaceAll([thread]);
    useManagerThreadsStore.setState({
      archived: [{ id: "thr_old", title: "project-1 cache expiry", archivedAt: "2026-10-13T09:00:00.000Z", workers: 2, canvases: 0 }],
      archivedLoaded: true
    });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/threads/thr_old"]}>
      <PaneHeaderSlotsProvider>
        <TopBar />
        <Routes><Route path="/threads/:threadId" element={<ThreadPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  expect(host.querySelector("header")?.textContent).toContain("project-1 cache expiry");
  expect(host.querySelector("textarea") === null).toBe(true);
  expect(host.querySelector('[data-slot="archived-note"]')?.textContent).toBe("Archived on Oct 13. You can read it here; nothing more can be sent.");
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')?.textContent).toBe("Workers2");
});

// On a phone a canvas opens full screen, over the page, as before: it never
// becomes a tab in the sheet.
const CANVAS = "cnv_RelNotes001";

test("phone: a canvas link in the chat opens the canvas over the page", async () => {
  transcript = [{
    id: "m1", threadId: "thr_a", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wk", createdAt: at,
    content: { type: "assistant", text: `The write-up: [the release report](/canvas/${CANVAS}).` }
  }];
  const el = await render();
  await settleUntil(() => el.querySelector(`a[href="/canvas/${CANVAS}"]`) !== null, "the link in the transcript");
  await act(async () => { el.querySelector<HTMLElement>(`a[href="/canvas/${CANVAS}"]`)!.click(); });
  expect(url).toBe(`/canvas/${CANVAS}`);
  expect(useWorkerPanelStore.getState().get("thr_a").tabs).toEqual([]);
});

test("phone: canvas tabs a wide window saved are not in the sheet", async () => {
  const el = await render();
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", `canvas:${CANVAS}`], active: `canvas:${CANVAS}`, workerTab: {} } } });
  });
  await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')!.click(); });
  await settle();
  expect(sheet()!.querySelector("[data-canvas-tab]") === null).toBe(true);
  expect(sheet()!.querySelector('[data-worker-tab="w1"]') === null).toBe(false);
  // The Workers tab shows in their place; the wide layout keeps them.
  expect(sheet()!.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("Workers");
  expect(useWorkerPanelStore.getState().get("thr_a").tabs).toEqual(["w1", `canvas:${CANVAS}`]);
});

// Closing a worker's tab in the sheet opens the worker tab beside it there,
// not a canvas tab the sheet does not show.
test("phone: closing a worker's tab opens its neighbour in the sheet, past canvas tabs it does not show", async () => {
  const el = await render();
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", `canvas:${CANVAS}`, "w9"], active: "w9", workerTab: {} } } });
  });
  await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')!.click(); });
  await settle();
  const close = sheet()!.querySelector<HTMLElement>('[data-worker-tab="w9"] [aria-label^="Close "]')!;
  await act(async () => { close.click(); });
  await settle();
  expect(sheet()!.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
  // The wide layout keeps the canvas tab.
  expect(useWorkerPanelStore.getState().get("thr_a").tabs).toEqual(["w1", `canvas:${CANVAS}`]);
});

// The worker's own menu closes its tab by the same rule.
test("phone: a worker's menu Close opens its neighbour in the sheet, past canvas tabs it does not show", async () => {
  const el = await render();
  act(() => {
    useProjectsStore.getState().setProjectsState([clientProject("p1", { features: [w1, clientFeature("w2")] })]);
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", `canvas:${CANVAS}`, "w2"], active: "w2", workerTab: { w2: "plan" } } } });
  });
  await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')!.click(); });
  await settle();
  const trigger = sheet()!.querySelector<HTMLElement>('button[aria-label="Worker actions"]')!;
  await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  const close = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Close")!;
  await act(async () => { close.click(); });
  await settle();
  expect(sheet()!.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
});

// A worker the thread no longer has (gone from its archive too) says so in its
// tab; its Close tab follows the sheet's rule as the ✕ does.
test("phone: a missing worker's Close tab opens its neighbour in the sheet, past canvas tabs it does not show", async () => {
  const el = await render();
  act(() => {
    useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", `canvas:${CANVAS}`, "w9"], active: "w9", workerTab: {} } } });
  });
  await act(async () => { el.querySelector<HTMLButtonElement>('button[aria-label="Workers"]')!.click(); });
  await settleUntil(() => [...sheet()!.querySelectorAll("button")].some((b) => b.textContent === "Close tab"), "the missing worker's note");
  await act(async () => { [...sheet()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Close tab")!.click(); });
  await settle();
  expect(sheet()!.querySelector('[data-worker-tab="w1"]')?.getAttribute("aria-selected")).toBe("true");
});
