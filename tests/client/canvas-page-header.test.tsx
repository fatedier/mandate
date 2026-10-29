import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { CanvasPage } from "@/routes/canvas/CanvasPage";
import { PaneHeader } from "@/shell/PaneHeader";
import { TopBar } from "@/shell/TopBar";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { toast } from "sonner";

/** The canvas page's title and controls live in the app's own header — the
 *  pane header on a desktop, the top bar on a phone — instead of a second
 *  header row under one that showed the canvas id. happy-dom does no layout:
 *  the half-width rule is asserted as the container classes that carry it. */


const report = {
  id: "cnv_Uy6tRe5wQa3", title: "Cache expiry investigation", kind: "report", html: "<p>ok</p>", contentRevision: 1,
  scope: "worker", scopeId: "feat_1", projectId: "proj_1", projectName: "project-1", projectSlug: "md-project-1",
  // A name that is not its slug, so a link built from the name reads wrong.
  featureId: "feat_1", featureName: "Evict hook", featureSlug: "evicthook", threadId: "thread_1",
  createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z"
};

/** The canvas page under the app's header: the top bar on a phone, the pane
 *  header on a desktop. */
function page(path: string, phone: boolean) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <PaneHeaderSlotsProvider>
        {phone ? <TopBar /> : <PaneHeader />}
        <Routes><Route path="/canvas/:canvasId" element={<CanvasPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
}

async function render(phone: boolean) {
  if (phone) onCleanup(fakePhoneWidth());
  mockFetch(() => Response.json({ canvas: report }));
  const { host } = await mountAsync(page(`/canvas/${report.id}`, phone));
  await settle();
  return host;
}

const pointerDown = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((i) => (i.getAttribute("aria-label") ?? i.textContent ?? "").trim());

test("desktop: one header row carries the canvas's title, where it belongs, a menu and Close; never its id", async () => {
  const el = await render(false);
  const header = el.querySelector<HTMLElement>('[data-slot="pane-header"]')!;
  expect(header.querySelector("h1")!.textContent).toBe("Cache expiry investigation");
  expect(header.textContent).toContain("project-1 / Evict hook");
  expect(header.textContent).not.toContain(report.id);
  expect(header.querySelector('[aria-label="Close canvas"]') !== null).toBe(true);
  expect(header.querySelector('button[aria-label="Canvas menu"]') !== null).toBe(true);
  // Zoom, the feature and refresh are in the menu, as on a phone.
  for (const inMenu of ['button[aria-label^="Zoom, "]', 'a[aria-label^="Open worker"]', '[aria-label="Refresh canvas"]', 'button[role="switch"]']) {
    expect([inMenu, header.querySelector(inMenu) === null]).toEqual([inMenu, true]);
  }
  // No second title row under it.
  expect(el.querySelectorAll("header")).toHaveLength(1);
  expect(el.querySelectorAll("h1")).toHaveLength(1);
});

test("phone: the top bar is the canvas's title, a menu and Close; zoom, the feature and refresh are in the menu", async () => {
  const el = await render(true);
  const bar = el.querySelector("header")!;
  expect(bar.querySelector("h1")!.textContent).toBe("Cache expiry investigation");
  expect(bar.querySelector('nav[aria-label="Breadcrumb"]') === null).toBe(true);
  expect(bar.textContent).not.toContain(report.id);
  expect(bar.querySelector('[aria-label="Close canvas"]') !== null).toBe(true);
  for (const inMenu of ['button[aria-label^="Zoom, "]', 'a[aria-label^="Open worker"]', '[aria-label="Refresh canvas"]']) {
    expect(bar.querySelector(inMenu) === null).toBe(true);
  }
  expect(el.querySelectorAll("header")).toHaveLength(1);

  await act(async () => {
    bar.querySelector('button[aria-label="Canvas menu"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((i) => (i.getAttribute("aria-label") ?? i.textContent ?? "").trim());
  for (const name of ["Desktop site", "Zoom out", "Zoom in", "Open worker", "Refresh", "Delete canvas…"]) expect(items).toContain(name);
  expect(items.at(-1)).toBe("Delete canvas…");
  const open = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Open worker")!;
  expect(open.getAttribute("href")).toBe("/projects/md-project-1/features/evicthook");
});

test("phone: the menu's Refresh waits while the canvas is loading, as the button did", async () => {
  onCleanup(fakePhoneWidth());
  // The first read never answers: the page is loading.
  mockFetch(() => new Promise<Response>(() => {}));
  const { host } = await mountAsync(page(`/canvas/${report.id}`, true));
  const bar = host.querySelector("header")!;
  expect(bar.querySelector("h1")!.textContent).toBe("Loading canvas");
  await act(async () => {
    bar.querySelector('button[aria-label="Canvas menu"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  const refresh = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Refresh")!;
  expect(refresh.getAttribute("aria-disabled")).toBe("true");
});

test("a missing canvas says so in the page, not as server text in a red box; the header stops saying it is loading", async () => {
  mockFetch(() => Response.json({ error: "canvas not found" }, { status: 404 }));
  const { host } = await mountAsync(page("/canvas/cnv_gone", false));
  await settle();
  const header = host.querySelector('[data-slot="pane-header"]')!;
  expect(header.querySelector("h1")!.textContent).toBe("Canvas");
  // Close and the menu stay: the way out, and Refresh to try again. Nothing to delete.
  expect(header.querySelector('[aria-label="Close canvas"]') !== null).toBe(true);
  await act(async () => { pointerDown(header.querySelector('button[aria-label="Canvas menu"]')!); });
  expect(menuItems()).toEqual(["Refresh"]);
  const state = host.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Canvas not found");
  expect(state.textContent).toContain("It was deleted, or the link is wrong.");
  expect(state.textContent).not.toContain("canvas not found");
  expect([...state.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Close"]);
  // Not the red box it used to be.
  expect(host.querySelector('.text-destructive, [class*="bg-destructive/"]') === null).toBe(true);
});

test("a canvas that fails to load says why and can retry", async () => {
  let reads = 0;
  mockFetch(() => {
    reads++;
    return reads === 1 ? Response.json({ error: "database is locked" }, { status: 500 }) : Response.json({ canvas: report });
  });
  const { host } = await mountAsync(page(`/canvas/${report.id}`, false));
  await settle();
  const state = host.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Couldn't load this canvas");
  expect(state.textContent).toContain("database is locked");
  await act(async () => { [...state.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click(); });
  await settle();
  expect(host.querySelector('[data-slot="state-message"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="pane-header"] h1')!.textContent).toBe("Cache expiry investigation");
});

test("a loading canvas shows one quiet line, not a skeleton", async () => {
  mockFetch(() => new Promise<Response>(() => {}));
  const { host } = await mountAsync(page(`/canvas/${report.id}`, false));
  expect(host.querySelector('[data-slot="loading-line"]')?.textContent).toBe("Loading…");
  expect(host.querySelector('[data-slot="skeleton"]') === null).toBe(true);
});

test("an embedded missing canvas offers no Close: its frame belongs to the page around it", async () => {
  mockFetch(() => Response.json({ error: "canvas not found" }, { status: 404 }));
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/canvas/cnv_gone/embed"]}>
      <PaneHeaderSlotsProvider>
        <Routes><Route path="/canvas/:canvasId/embed" element={<CanvasPage presentation="embed" />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  const state = host.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Canvas not found");
  expect(state.querySelector("button, a") === null).toBe(true);
});


test("Delete canvas… asks first, deletes it, and leaves the canvas", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  mockFetch((call) => {
    requests.push({ method: call.method, url: call.url });
    return call.method === "DELETE" ? Response.json({ ok: true }) : Response.json({ canvas: report });
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/somewhere", `/canvas/${report.id}`]} initialIndex={1}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes>
          <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          <Route path="*" element={<p data-slot="left-canvas">left</p>} />
        </Routes>
      </PaneHeaderSlotsProvider>
      <ConfirmHost />
    </MemoryRouter>
  );
  await settle();
  await act(async () => { pointerDown(host.querySelector('[data-slot="pane-header"] button[aria-label="Canvas menu"]')!); });
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Delete canvas…")!.click(); });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Delete canvas "Cache expiry investigation"?');
  expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  await act(async () => { [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click(); });
  await settle();
  expect(requests.filter((r) => r.method === "DELETE")).toStrictEqual([{ method: "DELETE", url: `/api/canvas/${report.id}` }]);
  expect(host.querySelector('[data-slot="left-canvas"]') !== null).toBe(true);
});

test("a delete that fails says why and keeps the canvas open", async () => {
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => { shown.push(String(message)); return 0; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  mockFetch((call) => call.method === "DELETE"
    ? Response.json({ error: "disk is read-only" }, { status: 500 })
    : Response.json({ canvas: report }));
  const { host } = await mountAsync(<>{page(`/canvas/${report.id}`, false)}<ConfirmHost /></>);
  await settle();
  await act(async () => { pointerDown(host.querySelector('[data-slot="pane-header"] button[aria-label="Canvas menu"]')!); });
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Delete canvas…")!.click(); });
  await act(async () => { [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click(); });
  await settle();
  expect(shown).toStrictEqual(["Delete failed: disk is read-only"]);
  expect(host.querySelector('[data-slot="pane-header"] h1')!.textContent).toBe("Cache expiry investigation");
});

// What happens while the delete is out: the paths navigated before it answers.
const lateDeleteRows: Array<{ name: string; steps: string[] }> = [
  {
    // The agent opens another canvas.
    name: "a delete that answers after another canvas was opened leaves that one open",
    steps: ["/canvas/cnv_other"]
  },
  {
    // The viewer closes, and another canvas opens in a new one.
    name: "a delete that answers after its viewer was closed and another canvas opened leaves that one open",
    steps: ["/list", "/canvas/cnv_other"]
  }
];

test.each(lateDeleteRows)("$name", async ({ steps }) => {
  let answer: (res: Response) => void = () => {};
  const other = { ...report, id: "cnv_other", title: "Another report" };
  mockFetch((call) => {
    if (call.method === "DELETE") return new Promise<Response>((resolve) => { answer = resolve; });
    return Response.json({ canvas: call.url.endsWith("cnv_other") ? other : report });
  });
  let go: (to: string) => void = () => {};
  function Navigator() {
    const navigate = useNavigate();
    go = (to) => navigate(to);
    return null;
  }
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/somewhere", `/canvas/${report.id}`]} initialIndex={1}>
      <Navigator />
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes>
          <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          <Route path="/list" element={<p data-slot="the-list">list</p>} />
          <Route path="*" element={<p data-slot="left-canvas">left</p>} />
        </Routes>
      </PaneHeaderSlotsProvider>
      <ConfirmHost />
    </MemoryRouter>
  );
  await settle();
  await act(async () => { pointerDown(host.querySelector('[data-slot="pane-header"] button[aria-label="Canvas menu"]')!); });
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Delete canvas…")!.click(); });
  await act(async () => { [...document.querySelector('[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click(); });
  for (const to of steps) {
    await act(async () => { go(to); });
    await settle();
  }
  expect(host.querySelector('[data-slot="pane-header"] h1')!.textContent).toBe("Another report");
  await act(async () => { answer(Response.json({ ok: true })); });
  await settle();
  expect(host.querySelector('[data-slot="left-canvas"]') !== null).toBe(false);
  expect(host.querySelector('[data-slot="pane-header"] h1')!.textContent).toBe("Another report");
});
