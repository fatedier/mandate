import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FeatureCanvasTab } from "@/routes/window/FeatureCanvasTab";

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

const CANVAS = {
  id: "cnv_1", title: "Issue #5460 · final status", html: "<h1>Hello</h1>",
  updatedAt: "2026-09-15T09:00:00.000Z", contentRevision: 1
};

beforeEach(() => {
  (globalThis as { fetch: FetchStub }).fetch = async () => new Response(JSON.stringify({ canvas: CANVAS }), {
    status: 200, headers: { "content-type": "application/json" }
  });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

async function render(loadTimeoutMs?: number, active = true, containerWidth?: number) {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={["/projects/p/features/f"]}>
        <FeatureCanvasTab canvasId="cnv_1" active={active} loadTimeoutMs={loadTimeoutMs} containerWidth={containerWidth} />
      </MemoryRouter>
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return host!;
}

test("the card shows its title, an Open link and a skeleton until the frame reports a height", async () => {
  const el = await render();
  expect(el.querySelector('[data-slot="canvas-title"]')?.textContent).toContain("Issue #5460 · final status");
  const open = el.querySelector<HTMLAnchorElement>('[data-slot="canvas-open"]');
  expect(open === null).toBe(false);
  expect(open!.getAttribute("href")).toBe("/canvas/cnv_1");
  const skeleton = el.querySelector('[data-slot="canvas-skeleton"]');
  expect(skeleton === null).toBe(false);
  expect(skeleton!.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  expect(el.querySelector('[data-slot="canvas-failed"]') === null).toBe(true);
  // The frame is mounted (so it can load) but takes no space and is hidden from AT.
  const frame = el.querySelector("iframe")!;
  expect(frame.getAttribute("aria-hidden")).toBe("true");
  expect(frame.style.height).toBe("0px");
});

test("after the load timeout the skeleton gives way to a failure row with Retry", async () => {
  const el = await render(20);
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(el.querySelector('[data-slot="canvas-skeleton"]') === null).toBe(true);
  const failed = el.querySelector('[data-slot="canvas-failed"]');
  expect(failed === null).toBe(false);
  expect(failed!.textContent).toContain("Canvas didn't load");
  const retry = failed!.querySelector<HTMLButtonElement>('button[aria-label="Retry canvas"]');
  expect(retry === null).toBe(false);
  const before = el.querySelector("iframe");
  await act(async () => { retry!.click(); });
  // Retry remounts the frame (a new element, not a re-render) and returns to the skeleton.
  expect(el.querySelector("iframe") !== before).toBe(true);
  expect(el.querySelector('[data-slot="canvas-skeleton"]') === null).toBe(false);
  expect(el.querySelector('[data-slot="canvas-failed"]') === null).toBe(true);
});

test("a hidden card never times out: no frame is mounted, so there is nothing to wait for", async () => {
  const el = await render(20, false);
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(el.querySelector("iframe") === null).toBe(true);
  expect(el.querySelector('[data-slot="canvas-failed"]') === null).toBe(true);
  expect(el.querySelector('[data-slot="canvas-skeleton"]') === null).toBe(false);
});

test("the header shows a fit caption only when the canvas is scaled", async () => {
  await render(undefined, true, 358);
  const frame = host!.querySelector("iframe")!;
  // happy-dom's MessageEvent accepts the frame's window as the source; bun's native global rejects it.
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.height", canvasId: "cnv_1", value: 400 }, source: frame.contentWindow as Window }));
  });
  expect(host!.querySelector('[data-slot="canvas-fit"]') === null).toBe(true);
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.height", canvasId: "cnv_1", value: 400, width: 1200 }, source: frame.contentWindow as Window }));
  });
  const caption = host!.querySelector('[data-slot="canvas-fit"]');
  expect(caption === null).toBe(false);
  // 1200 wide into 358 → 29.8% → rounds to 30.
  expect(caption!.textContent).toBe("fit · 30%");
  const tokens = caption!.className.split(/\s+/);
  expect(tokens).toContain("text-2xs");
  expect(tokens).toContain("text-faint");
});

test("while the document is still fetching the card shows the skeleton with no frame and no failure row", async () => {
  (globalThis as { fetch: FetchStub }).fetch = () => new Promise<Response>(() => {});
  const el = await render();
  expect(el.querySelector('[data-slot="canvas-skeleton"]') === null).toBe(false);
  expect(el.querySelector('[data-slot="canvas-failed"]') === null).toBe(true);
  // No document yet, so there is no frame to load.
  expect(el.querySelector("iframe") === null).toBe(true);
});
