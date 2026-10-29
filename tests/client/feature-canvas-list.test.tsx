import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { FeatureCanvasList } from "@/routes/window/FeatureCanvasList";
import { useFeatureCanvases } from "@/routes/window/use-feature-canvases";
import { useWorkItemsStore } from "@/store/work-items";
import type { WorkItemDto } from "@shared/api/work-items";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
// Aliased: this file's own stub() stubs the fetch.
import { stub as partialDto } from "../helpers/typed.js";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { useAgentPageUi } from "@/store/agent-page-ui";

function stub(body: unknown, status = 200) {
  mockFetch(() => jsonResponse(body, status));
}

beforeEach(() => {
  useWorkItemsStore.setState({ items: new Map([["wi1", partialDto<WorkItemDto>({ id: "wi1", featureId: "f1" })]]) });
});
afterEach(() => {
  // Unmount before the work items the list reads are reset under it.
  runCleanups();
  useWorkItemsStore.setState({ items: new Map() });
});

/** The Reports tab and the Overview both hold the fetch and pass it down. */
function Reports() {
  return <FeatureCanvasList state={useFeatureCanvases("f1")} />;
}

async function render() {
  const { host } = await mountAsync(<MemoryRouter><Reports /></MemoryRouter>);
  // The fetch is debounced through window.setTimeout inside the effect, and
  // React flushes that effect only when the render act resolves — so the wait
  // must be its own act for the resulting state update to land inside one.
  await settle(150);
  return host;
}

test("canvases render as quiet rows in one container, every one a report: no Dashboard pill", async () => {
  stub({ canvases: [
    { id: "cnv_dash", title: "Delivery status", updatedAt: "2026-09-15T09:00:00.000Z" },
    { id: "cnv_2", title: "Design notes", updatedAt: "2026-09-14T09:00:00.000Z" }
  ] });
  const el = await render();
  const list = el.querySelector('[data-slot="canvas-list"]')!;
  expect(list === null).toBe(false);
  expect(list.className.split(/\s+/)).toContain("bg-panel");
  const rows = list.querySelectorAll('[data-slot="canvas-row"]');
  expect(rows.length).toBe(2);
  // Under the Reports tab, each row opens a report.
  expect([...rows].map((row) => row.querySelector("button")!.getAttribute("aria-label"))).toEqual(["Open report: Delivery status", "Open report: Design notes"]);
  // The work item still names cnv_dash as its canvas (old data); binding is
  // retired, so no row is singled out.
  expect(list.querySelectorAll(".pill").length).toBe(0);
  expect(rows[0]!.textContent).toContain("Delivery status");
  // Colour rule: no primary tint anywhere in the list.
  expect(list.innerHTML).not.toContain("primary");
});

test("empty is one faint line, not a dashed box", async () => {
  stub({ canvases: [] });
  const el = await render();
  expect(el.querySelector('[data-slot="canvas-list"]') === null).toBe(true);
  const empty = el.querySelector('[data-slot="canvas-empty"]');
  expect(empty === null).toBe(false);
  expect(empty!.textContent).toBe("No canvases yet. Reports and designs the agent makes for this feature show up here.");
  expect(empty!.className.split(/\s+/)).toContain("text-faint");
});

test("an error is the inline error: a plain sentence, the server text below, and Retry fetches again", async () => {
  let calls = 0;
  mockFetch(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ canvases: [] });
  });
  const el = await render();
  const failed = el.querySelector('[data-slot="inline-error"]');
  expect(failed === null).toBe(false);
  expect(failed!.getAttribute("role")).toBe("alert");
  expect(failed!.textContent).toContain("Couldn't load canvases.");
  // The server text is the small line, never the sentence.
  expect(failed!.querySelector("p")!.textContent).toBe("boom");
  const retry = [...failed!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
  expect(retry === undefined).toBe(false);
  await act(async () => { retry.click(); });
  await settle(150);
  expect(calls).toBe(2);
  expect(el.querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(el.querySelector('[data-slot="canvas-empty"]') === null).toBe(false);
});

test("while the list is still fetching, one Loading… line stands in: no skeleton, no row", async () => {
  mockFetch(() => new Promise<Response>(() => {}));
  const el = await render();
  const loading = el.querySelector('[data-slot="loading-line"]');
  expect(loading === null).toBe(false);
  expect(loading!.textContent).toBe("Loading…");
  expect(el.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  expect(el.querySelector('[data-slot="canvas-list"]') === null).toBe(true);
  expect(el.querySelectorAll('[data-slot="canvas-row"]').length).toBe(0);
});

test("reports and designs share one list, each row labelled with its kind", async () => {
  stub({ canvases: [
    { id: "cnv_r", title: "Latency findings", kind: "report", updatedAt: "2026-09-15T09:00:00.000Z" },
    { id: "cnv_d", title: "Checkout redesign", kind: "design", updatedAt: "2026-09-14T09:00:00.000Z" }
  ] });
  const el = await render();
  const rows = [...el.querySelectorAll('[data-slot="canvas-row"] button[aria-label^="Open "]')];
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Open report: Latency findings", "Open design: Checkout redesign"]);
  expect(rows.map((row) => row.querySelector('[data-slot="canvas-kind"]')?.textContent)).toStrictEqual(["Report", "Design"]);
});

const openMenu = async (button: Element) => {
  // Radix opens a menu on pointerdown, not click.
  await act(async () => { button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
};
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === name);

test("each row's menu deletes its canvas after asking, and the list is told to refetch", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  mockFetch((call) => {
    requests.push({ method: call.method, url: call.url });
    if (call.method === "DELETE") return jsonResponse({ ok: true });
    return jsonResponse({ canvases: [
      { id: "cnv_old", title: "Old report", kind: "report", updatedAt: "2026-09-10T09:00:00.000Z" },
      { id: "cnv_new", title: "New report", kind: "report", updatedAt: "2026-09-14T09:00:00.000Z" }
    ] });
  });
  const { host } = await mountAsync(<MemoryRouter><Reports /><ConfirmHost /></MemoryRouter>);
  await settle(150);
  const told: unknown[] = [];
  const listener = (event: Event) => told.push((event as CustomEvent).detail);
  window.addEventListener("mandate:canvas-updated", listener);
  onCleanup(() => window.removeEventListener("mandate:canvas-updated", listener));

  const rows = host.querySelectorAll('[data-slot="canvas-row"]');
  // The whole row still opens the canvas; the menu is a separate button.
  expect(rows[0]!.querySelector("button")!.getAttribute("aria-label")).toBe("Open report: Old report");
  await openMenu(rows[0]!.querySelector('button[aria-label="Canvas actions: Old report"]')!);
  await act(async () => { menuItem("Delete canvas…")!.click(); });
  // It asks first, naming the canvas.
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Delete canvas "Old report"?');
  expect(dialog.textContent).toContain("This can't be undone.");
  expect(requests.filter((r) => r.method === "DELETE")).toStrictEqual([]);
  await act(async () => { [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click(); });
  await settle();
  expect(requests.filter((r) => r.method === "DELETE")).toStrictEqual([{ method: "DELETE", url: "/api/canvas/cnv_old" }]);
  expect(told).toStrictEqual([{ canvasId: "cnv_old", featureId: "f1" }]);
});

test("cancelling the question deletes nothing and puts focus back on the row's menu button, not on the page", async () => {
  const methods: string[] = [];
  mockFetch((call) => {
    methods.push(call.method);
    return jsonResponse({ canvases: [{ id: "cnv_old", title: "Old report", kind: "report", updatedAt: "2026-09-10T09:00:00.000Z" }] });
  });
  const { host } = await mountAsync(<MemoryRouter><Reports /><ConfirmHost /></MemoryRouter>);
  await settle(150);
  const trigger = host.querySelector<HTMLElement>('button[aria-label="Canvas actions: Old report"]')!;
  await openMenu(trigger);
  // Chosen from the keyboard: the item holds focus when the question opens,
  // and the menu takes it away as it closes.
  const item = menuItem("Delete canvas…")!;
  item.focus();
  await act(async () => { item.click(); });
  const dialog = document.querySelector('[role="dialog"]')!;
  await act(async () => { [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click(); });
  await settle();
  expect(methods.includes("DELETE")).toBe(false);
  expect(document.activeElement === trigger).toBe(true);
});

// A canvas deleted from a worker's list closes its tabs wherever they are:
// a thread's panel, Your agent's side.
test("deleting a canvas closes its tabs in every panel", async () => {
  mockFetch((call) => {
    if (call.method === "DELETE") return jsonResponse({ ok: true });
    return jsonResponse({ canvases: [{ id: "cnv_old", title: "Old report", kind: "report", updatedAt: "2026-09-10T09:00:00.000Z" }] });
  });
  act(() => {
    useWorkerPanelStore.setState({ byThread: {
      thr_a: { open: true, tabs: ["f1", "canvas:cnv_old"], active: "canvas:cnv_old", workerTab: {} },
      thr_b: { open: true, tabs: ["canvas:cnv_keep", "canvas:cnv_old"], active: "canvas:cnv_keep", workerTab: {} }
    } });
    useAgentPageUi.setState({ tabs: ["canvas:cnv_old"], active: "canvas:cnv_old" });
  });
  onCleanup(() => {
    useWorkerPanelStore.setState({ byThread: {} });
    useAgentPageUi.setState({ tabs: [], active: "page" });
  });
  const { host } = await mountAsync(<MemoryRouter><Reports /><ConfirmHost /></MemoryRouter>);
  await settle(150);
  await openMenu(host.querySelector('button[aria-label="Canvas actions: Old report"]')!);
  await act(async () => { menuItem("Delete canvas…")!.click(); });
  const dialog = document.querySelector('[role="dialog"]')!;
  await act(async () => { [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click(); });
  await settle();
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["f1"], active: "f1" });
  expect(useWorkerPanelStore.getState().get("thr_b")).toMatchObject({ tabs: ["canvas:cnv_keep"], active: "canvas:cnv_keep" });
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [], active: "page" });
});
