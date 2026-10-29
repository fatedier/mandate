import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { CanvasView } from "@/routes/canvas/CanvasPage";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { formatClockMinutes } from "@/lib/format";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

// A canvas in a right panel's tab: one bar under the tab row with its title,
// its kind and when it was updated, and the canvas menu, which closes the
// tab. The tab has the ✕; the bar has none.

const report = {
  id: "cnv_Uy6tRe5wQa3", title: "Cache expiry investigation", kind: "report", html: "<p>ok</p>", contentRevision: 1,
  scope: "worker", scopeId: "feat_1", projectId: "proj_1", projectName: "project-1", projectSlug: "md-project-1",
  featureId: "feat_1", featureName: "Evict hook", featureSlug: "evicthook", threadId: "thread_1",
  createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T09:16:00.000Z"
};

let pathname = "";
function Where() {
  pathname = useLocation().pathname;
  return null;
}

async function render(props: { onClose?: () => void; openWorker?: (featureId: string) => boolean }, answer: () => Response = () => Response.json({ canvas: report })) {
  const requests: Array<{ method: string; url: string }> = [];
  mockFetch((call) => {
    requests.push({ method: call.method, url: call.url });
    return call.method === "DELETE" ? Response.json({ ok: true }) : answer();
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/threads/thr_a"]}>
      <Routes><Route path="*" element={<CanvasView canvasId={report.id} presentation="panel" {...props} />} /></Routes>
      <Where />
      <ConfirmHost />
    </MemoryRouter>
  );
  await settle();
  return { host, requests };
}

const pointerDown = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === name);

test("a canvas in a panel tab says its kind and when it was updated, and closes from its menu", async () => {
  const closed: string[] = [];
  const { host } = await render({ onClose: () => closed.push("closed") });
  const bar = host.querySelector('[data-slot="canvas-tab-bar"]')!;
  expect(bar.textContent).toContain("Cache expiry investigation");
  expect(bar.textContent).toContain(`Report · updated ${formatClockMinutes(report.updatedAt)}`);
  expect(host.querySelector('[aria-label="Close canvas"]') === null).toBe(true);
  await act(async () => { pointerDown(bar.querySelector('button[aria-label="Canvas menu"]')!); });
  const names = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((i) => (i.getAttribute("aria-label") ?? i.textContent ?? "").trim());
  expect(names.slice(-2)).toEqual(["Close tab", "Delete canvas…"]);
  await act(async () => { item("Close tab")!.click(); });
  expect(closed).toEqual(["closed"]);
});

test("a design in a panel tab says Design", async () => {
  const design = { ...report, kind: "design", html: "", design: { index: { title: null, pages: [{ id: "p1", name: "Page 1" }], boards: [], notes: [], launch: { view: "canvas", page: "p1" } }, artboards: {} } };
  const { host } = await render({}, () => Response.json({ canvas: design }));
  expect(host.querySelector('[data-slot="canvas-tab-bar"]')!.textContent).toContain(`Design · updated ${formatClockMinutes(report.updatedAt)}`);
});

test("deleting the canvas in a panel tab closes the tab", async () => {
  const closed: string[] = [];
  const { host, requests } = await render({ onClose: () => closed.push("closed") });
  await act(async () => { pointerDown(host.querySelector('[data-slot="canvas-tab-bar"] button[aria-label="Canvas menu"]')!); });
  await act(async () => { item("Delete canvas…")!.click(); });
  await act(async () => { [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click(); });
  await settle();
  expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  expect(closed).toEqual(["closed"]);
  expect(pathname).toBe("/threads/thr_a");
});

test("a missing canvas in a panel tab offers Close tab", async () => {
  const closed: string[] = [];
  const { host } = await render({ onClose: () => closed.push("closed") }, () => Response.json({ error: "canvas not found" }, { status: 404 }));
  const state = host.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Canvas not found");
  const buttons = [...state.querySelectorAll("button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["Close tab"]);
  await act(async () => { buttons[0]!.click(); });
  expect(closed).toEqual(["closed"]);
});

test("Open worker in a panel tab asks the page first, and goes to the worker's page when it says no", async () => {
  const asked: string[] = [];
  let answer = true;
  const { host } = await render({ openWorker: (featureId) => { asked.push(featureId); return answer; } });
  const open = async () => {
    await act(async () => { pointerDown(host.querySelector('[data-slot="canvas-tab-bar"] button[aria-label="Canvas menu"]')!); });
    await act(async () => { item("Open worker")!.click(); });
    await settle();
  };
  await open();
  expect([asked, pathname]).toEqual([["feat_1"], "/threads/thr_a"]);
  answer = false;
  await open();
  expect([asked, pathname]).toEqual([["feat_1", "feat_1"], "/projects/md-project-1/features/evicthook"]);
});

// Esc pressed inside a report's frame does not bubble out of it: in a panel's
// tab the frame passes it on, so Esc gives a panel that has the row back to
// the chat, as on the canvas's other pages.
test("Esc inside a report in a panel tab reaches the page", async () => {
  mockFetch(() => Response.json({ canvas: report }));
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/threads/thr_a"]}>
      <div data-slot="canvas-tab-view"><CanvasView canvasId={report.id} presentation="panel" /></div>
    </MemoryRouter>
  );
  await settle();
  const frame = host.querySelector("iframe")!;
  const keys: string[] = [];
  host.addEventListener("keydown", (event) => { keys.push((event as KeyboardEvent).key); });
  frame.focus();
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.key", canvasId: report.id, key: "Escape" }, source: frame.contentWindow as Window }));
  });
  expect(keys).toEqual(["Escape"]);
});
