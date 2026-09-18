import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FeatureArtifactsTab } from "@/routes/window/FeatureArtifactsTab";
import { useWorkItemsStore } from "@/store/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

function stub(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

beforeEach(() => {
  useWorkItemsStore.setState({ items: new Map([["wi1", { id: "wi1", featureId: "f1", canvasId: "cnv_dash" } as never]]) });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  useWorkItemsStore.setState({ items: new Map() });
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<MemoryRouter><FeatureArtifactsTab featureId="f1" /></MemoryRouter>);
  });
  // The fetch is debounced through window.setTimeout inside the effect, and
  // React flushes that effect only when the render act resolves — so the wait
  // must be its own act for the resulting state update to land inside one.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  return host!;
}

test("canvases render as quiet rows in one container; the bound one wears a neutral Dashboard pill", async () => {
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
  const pills = list.querySelectorAll(".pill");
  expect(pills.length).toBe(1);
  expect(pills[0]!.className.split(/\s+/)).toContain("pill-neutral");
  expect(pills[0]!.textContent).toBe("Dashboard");
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
  expect(empty!.textContent).toContain("No canvases yet");
  expect(empty!.className.split(/\s+/)).toContain("text-faint");
});

test("an error is one line with Retry", async () => {
  stub({ error: "boom" }, 500);
  const el = await render();
  const failed = el.querySelector('[data-slot="canvas-list-failed"]');
  expect(failed === null).toBe(false);
  expect(failed!.textContent).toContain("boom");
  expect(failed!.querySelector('button[aria-label="Retry canvases"]') === null).toBe(false);
});

test("while the list is still fetching, three skeleton rows stand in and no real row is rendered", async () => {
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const el = await render();
  const busy = el.querySelector('[data-slot="canvas-list"][aria-busy="true"]');
  expect(busy === null).toBe(false);
  const rows = Array.from(busy!.children);
  expect(rows.length).toBe(3);
  for (const row of rows) {
    expect(row.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  }
  expect(el.querySelectorAll('[data-slot="canvas-row"]').length).toBe(0);
});
