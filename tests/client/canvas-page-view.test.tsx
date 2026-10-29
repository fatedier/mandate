import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { CanvasModal, CanvasPage } from "@/routes/canvas/CanvasPage";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { ConfirmHost } from "@/components/ConfirmDialog";

let host: HTMLElement | null = null;

const canvas = (id: string) => ({
  id, title: `Report ${id}`, kind: "report", html: "<title>x</title><p>x</p>", contentRevision: 1,
  scope: "manager", scopeId: null, projectId: null, projectName: null, projectSlug: null,
  featureId: null, featureName: null, featureSlug: null, threadId: "t1",
  createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z"
});

let go: (path: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  go = (path) => navigate(path);
  return null;
}

// In the document, not the mount: the modal is a dialog, drawn in a portal.
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="Canvas menu"]')!;
const openMenu = () => act(async () => { trigger().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
// The zoom the menu shows, between its - and + items; the menu is shut again after.
const shownZoom = async () => {
  await openMenu();
  const zoom = document.querySelector('[role="menu"] output')!.textContent;
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  return zoom;
};

test("every open of a canvas starts from its defaults, also when returning to one", async () => {
  mockFetch((call) => {
    const id = call.url.split("/").pop()!;
    return jsonResponse({ canvas: canvas(id) });
  });
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/canvas/cnv_a"]}>
      <Navigator />
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes><Route path="/canvas/:canvasId" element={<CanvasPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  )).host;
  await settle();
  expect(await shownZoom()).toBe("100%");
  await openMenu();
  const preset = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent?.trim() === "125%")!;
  await act(async () => { preset.click(); });
  expect(await shownZoom()).toBe("125%");
  await act(async () => { go("/canvas/cnv_b"); });
  await settle();
  expect(await shownZoom()).toBe("100%");
  await act(async () => { go("/canvas/cnv_a"); });
  await settle();
  expect(await shownZoom()).toBe("100%");
});

test("Esc that closes a menu in the canvas modal leaves the modal open; the next Esc closes it", async () => {
  mockFetch((call) => {
    const id = call.url.split("/").pop()!;
    return jsonResponse({ canvas: canvas(id) });
  });
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/", "/canvas/cnv_a"]} initialIndex={1}>
      <Routes>
        <Route path="/" element={<p data-testid="home">home</p>} />
        <Route path="/canvas/:canvasId" element={<CanvasModal />} />
      </Routes>
    </MemoryRouter>
  )).host;
  await settle();
  const escape = () => act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  // Radix opens menus on pointerdown, not click.
  await act(async () => { trigger().dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  expect(document.querySelector('[role="menu"]') !== null).toBe(true);
  await escape();
  await settle();
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
  expect(host!.querySelector('[data-testid="home"]') === null).toBe(true);
  // A held key's repeats are not a second press.
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true, cancelable: true }));
  });
  await settle();
  expect(host!.querySelector('[data-testid="home"]') === null).toBe(true);
  await escape();
  await settle();
  expect(host!.querySelector('[data-testid="home"]') !== null).toBe(true);
});

test("Delete canvas… chosen from the keyboard in the modal and cancelled with Esc keeps the modal and puts focus back on the menu button", async () => {
  mockFetch((call) => jsonResponse({ canvas: canvas(call.url.split("/").pop()!) }));
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/", "/canvas/cnv_a"]} initialIndex={1}>
      <Routes>
        <Route path="/" element={<p data-testid="home">home</p>} />
        <Route path="/canvas/:canvasId" element={<CanvasModal />} />
      </Routes>
      <ConfirmHost />
    </MemoryRouter>
  )).host;
  await settle();
  await act(async () => { trigger().dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Delete canvas…")!;
  item.focus();
  await act(async () => { item.click(); });
  expect(document.querySelector("[data-confirm-dialog]") !== null).toBe(true);
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(document.querySelector("[data-confirm-dialog]") === null).toBe(true);
  expect(host!.querySelector('[data-testid="home"]') === null).toBe(true);
  expect(document.activeElement === trigger()).toBe(true);
});

test("a focused design's controls sit in their own bar under the header, which keeps the title, the menu and Close", async () => {
  const board = (path: string, x: number) => ({ path, x, y: 0, w: 390, h: 844, title: path.replace(".html", ""), page: "main", expand: null, interactive: false, radius: 0 });
  const design = {
    ...canvas("cnv_d"), kind: "design", html: "", title: "Checkout redesign",
    design: {
      index: { title: "Checkout redesign", pages: [{ id: "main", name: "" }], boards: [board("Cart.html", 0), board("Pay.html", 470)], notes: [], launch: { view: "focused", path: "Pay.html" } },
      artboards: { "Cart.html": "<p>Cart</p>", "Pay.html": "<p>Pay</p>" }
    }
  };
  mockFetch(() => jsonResponse({ canvas: design }));
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/canvas/cnv_d"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes><Route path="/canvas/:canvasId" element={<CanvasPage />} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  )).host;
  await settle();
  const header = host!.querySelector('[data-slot="pane-header"]')!;
  const bar = host!.querySelector('[data-slot="design-focus-bar"]');
  expect(bar !== null).toBe(true);
  expect(bar!.querySelector('[aria-label="Previous artboard"]') !== null).toBe(true);
  expect(header.querySelector('[aria-label="Previous artboard"]') === null).toBe(true);
  expect(header.querySelector('[aria-label="Close canvas"]') !== null).toBe(true);
  expect(header.querySelector('button[aria-label="Canvas menu"]') !== null).toBe(true);
  expect(header.querySelector("h1")!.textContent).toBe("Checkout redesign");
});

test("Esc with the delete question open over a focused design answers the question and leaves the design focused", async () => {
  const board = (path: string, x: number) => ({ path, x, y: 0, w: 390, h: 844, title: path.replace(".html", ""), page: "main", expand: null, interactive: false, radius: 0 });
  const design = {
    ...canvas("cnv_d"), kind: "design", html: "", title: "Checkout redesign",
    design: {
      index: { title: "Checkout redesign", pages: [{ id: "main", name: "" }], boards: [board("Cart.html", 0), board("Pay.html", 470)], notes: [], launch: { view: "focused", path: "Pay.html" } },
      artboards: { "Cart.html": "<p>Cart</p>", "Pay.html": "<p>Pay</p>" }
    }
  };
  const methods: string[] = [];
  mockFetch((call) => { methods.push(call.method); return jsonResponse({ canvas: design }); });
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/canvas/cnv_d"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes><Route path="/canvas/:canvasId" element={<CanvasPage />} /></Routes>
      </PaneHeaderSlotsProvider>
      <ConfirmHost />
    </MemoryRouter>
  )).host;
  await settle();
  expect(host!.querySelector('[data-slot="design-focus-bar"]') !== null).toBe(true);
  await openMenu();
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === "Delete canvas…")!.click(); });
  expect(document.querySelector('[role="dialog"][data-state="open"]') !== null).toBe(true);
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
  expect(document.querySelector('[role="dialog"][data-state="open"]') !== null).toBe(false);
  expect(host!.querySelector('[data-slot="design-focus-bar"]') !== null).toBe(true);
  expect(methods.includes("DELETE")).toBe(false);
});

// The modal is a dialog layer, so the design's "an open dialog
// takes Esc first" must not count the dialog the design is in: Esc leaves the
// focused view first, as it did, and only the next one closes the modal.
test("in the modal, Esc leaves a design's focused view first; the next Esc closes the modal", async () => {
  const board = (path: string, x: number) => ({ path, x, y: 0, w: 390, h: 844, title: path.replace(".html", ""), page: "main", expand: null, interactive: false, radius: 0 });
  const design = {
    ...canvas("cnv_d"), kind: "design", html: "", title: "Checkout redesign",
    design: {
      index: { title: "Checkout redesign", pages: [{ id: "main", name: "" }], boards: [board("Cart.html", 0), board("Pay.html", 470)], notes: [], launch: { view: "focused", path: "Pay.html" } },
      artboards: { "Cart.html": "<p>Cart</p>", "Pay.html": "<p>Pay</p>" }
    }
  };
  mockFetch(() => jsonResponse({ canvas: design }));
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/", "/canvas/cnv_d"]} initialIndex={1}>
      <Routes>
        <Route path="/" element={<p data-testid="home">home</p>} />
        <Route path="/canvas/:canvasId" element={<CanvasModal />} />
      </Routes>
    </MemoryRouter>
  )).host;
  await settle();
  const modal = () => document.querySelector('[role="dialog"][aria-label="Canvas"]');
  const escape = () => act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(modal() !== null).toBe(true);
  expect(modal()!.querySelector('[data-slot="design-focus-bar"]') !== null).toBe(true);
  await escape();
  await settle();
  expect(modal() !== null).toBe(true);
  expect(modal()!.querySelector('[data-slot="design-focus-bar"]') === null).toBe(true);
  expect(host!.querySelector('[data-testid="home"]') === null).toBe(true);
  await escape();
  await settle();
  expect(modal() === null).toBe(true);
  expect(host!.querySelector('[data-testid="home"]') !== null).toBe(true);
});

test("the canvas modal is a dialog named Canvas, drawn outside the page it covers, with focus on it", async () => {
  mockFetch((call) => jsonResponse({ canvas: canvas(call.url.split("/").pop()!) }));
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/", "/canvas/cnv_a"]} initialIndex={1}>
      <Routes>
        <Route path="/" element={<p data-testid="home">home</p>} />
        <Route path="/canvas/:canvasId" element={<CanvasModal />} />
      </Routes>
    </MemoryRouter>
  )).host;
  await settle();
  const modal = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Canvas"]')!;
  expect(modal.getAttribute("data-state")).toBe("open");
  expect(host!.contains(modal)).toBe(false);
  expect(document.activeElement === modal).toBe(true);
  // A press on the backdrop beside it closes it, once.
  const backdrop = modal.parentElement!;
  await act(async () => { backdrop.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  // The rest of the press: the router applies the step back in a transition.
  await act(async () => { backdrop.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 })); });
  await settle();
  expect(document.querySelector('[role="dialog"][aria-label="Canvas"]') === null).toBe(true);
  expect(host!.querySelector('[data-testid="home"]') !== null).toBe(true);
});

// One modal serves every canvas entry: opening a second canvas over the first
// and closing it lands on the first without a remount, and the first must
// still close.
test("closing a canvas opened over another leaves the first one closable", async () => {
  mockFetch((call) => jsonResponse({ canvas: canvas(call.url.split("/").pop()!) }));
  let goTo: (path: string) => void = () => {};
  function Go() { const navigate = useNavigate(); goTo = (path) => navigate(path); return null; }
  host = (await mountAsync(
    <MemoryRouter initialEntries={["/", "/canvas/cnv_a"]} initialIndex={1}>
      <Go />
      <Routes>
        <Route path="/" element={<p data-testid="home">home</p>} />
        <Route path="/canvas/:canvasId" element={<CanvasModal />} />
      </Routes>
    </MemoryRouter>
  )).host;
  await settle();
  const title = () => document.querySelector('[role="dialog"][aria-label="Canvas"] h1')?.textContent ?? null;
  const escape = async () => {
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
  };
  await act(async () => { goTo("/canvas/cnv_b"); });
  await settle();
  expect(title()).toBe("Report cnv_b");
  await escape();
  expect(title()).toBe("Report cnv_a");
  await escape();
  expect(title()).toBe(null);
  expect(host!.querySelector('[data-testid="home"]') !== null).toBe(true);
});

// On a phone the canvas opens over the worker sheet, itself an open dialog,
// earlier in the document. Only what is open OVER the design takes Esc first.
test("an open dialog under the canvas modal does not take Esc from a design's focused view", async () => {
  const board = (path: string, x: number) => ({ path, x, y: 0, w: 390, h: 844, title: path.replace(".html", ""), page: "main", expand: null, interactive: false, radius: 0 });
  const design = {
    ...canvas("cnv_d"), kind: "design", html: "", title: "Checkout redesign",
    design: {
      index: { title: "Checkout redesign", pages: [{ id: "main", name: "" }], boards: [board("Cart.html", 0), board("Pay.html", 470)], notes: [], launch: { view: "focused", path: "Pay.html" } },
      artboards: { "Cart.html": "<p>Cart</p>", "Pay.html": "<p>Pay</p>" }
    }
  };
  mockFetch(() => jsonResponse({ canvas: design }));
  // The sheet: in the document before the modal's portal, and still open.
  const under = document.createElement("div");
  under.setAttribute("role", "dialog");
  under.setAttribute("data-state", "open");
  document.body.append(under);
  try {
    host = (await mountAsync(
      <MemoryRouter initialEntries={["/", "/canvas/cnv_d"]} initialIndex={1}>
        <Routes>
          <Route path="/" element={<p data-testid="home">home</p>} />
          <Route path="/canvas/:canvasId" element={<CanvasModal />} />
        </Routes>
      </MemoryRouter>
    )).host;
    await settle();
    const modal = () => document.querySelector('[role="dialog"][aria-label="Canvas"]');
    expect(modal()!.querySelector('[data-slot="design-focus-bar"]') !== null).toBe(true);
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect(modal() !== null).toBe(true);
    expect(modal()!.querySelector('[data-slot="design-focus-bar"]') === null).toBe(true);
  } finally {
    under.remove();
  }
});
