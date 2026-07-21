import { afterEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCanvasDocument } from "@/routes/canvas/useCanvasDocument";
import type { CanvasDocumentDto, CanvasUpdatedPayload } from "@shared/api-contracts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const mounted = new Set<{ root: Root; node: HTMLElement }>();
const values = new Map<string, ReturnType<typeof useCanvasDocument>>();

afterEach(async () => {
  for (const view of mounted) {
    await act(async () => view.root.unmount());
    view.node.remove();
  }
  mounted.clear();
  values.clear();
  globalThis.fetch = originalFetch;
});

function document(id = "one", title = "Original"): CanvasDocumentDto {
  return {
    id, title, html: `<h1>${title}</h1>`, kind: "html", scope: "manager", scopeId: null,
    projectId: null, projectName: null, projectSlug: null, featureId: null,
    featureName: null, featureSlug: null, threadId: "thread", contentRevision: 0,
    createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z"
  };
}

function captureFetches() {
  const calls: Array<{
    url: string; signal: AbortSignal;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  // Deliberately permit late delivery after abort to exercise stale-result guards.
  globalThis.fetch = ((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url, signal: init.signal!, resolve, reject });
  })) as typeof fetch;
  return calls;
}

function Probe({ name, id }: { name: string; id: string }) {
  const value = useCanvasDocument(id);
  values.set(name, value);
  return <output>{value.canvas?.title ?? value.error ?? "Loading"}</output>;
}

async function mount(name: string, id = "one", strict = false) {
  const node = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(node);
  const root = createRoot(node);
  const view = { root, node };
  mounted.add(view);
  const render = async (id: string) => {
    await act(async () => root.render(strict ? <StrictMode><Probe name={name} id={id} /></StrictMode> : <Probe name={name} id={id} />));
  };
  await render(id);
  return {
    node, render,
    close: async () => { await act(async () => root.unmount()); node.remove(); mounted.delete(view); }
  };
}

const updated = (canvasId = "one") => window.dispatchEvent(new CustomEvent<CanvasUpdatedPayload>("mandate:canvas-updated", { detail: { canvasId, featureId: null } }));
const reconnect = () => window.dispatchEvent(new CustomEvent("mandate:sse-open"));
const response = (id = "one", title = "Original") => Response.json({ canvas: document(id, title) });

test("mounted readers share an immediate request and one leaving does not abort it", async () => {
  const calls = captureFetches();
  const worker = await mount("worker");
  const modal = await mount("modal");
  expect(calls).toHaveLength(1);
  await modal.close();
  expect(calls[0]!.signal.aborted).toBe(false);
  await act(async () => calls[0]!.resolve(response()));
  expect(worker.node.textContent).toBe("Original");
  expect(values.get("worker")!.loading).toBe(false);
});

test("different Canvas IDs have independent concurrent requests", async () => {
  const calls = captureFetches();
  const first = await mount("first");
  const second = await mount("second", "two");
  expect(calls.map((call) => call.url)).toEqual(["/api/canvas/one", "/api/canvas/two"]);
  await act(async () => calls[1]!.resolve(response("two", "Second")));
  expect(second.node.textContent).toBe("Second");
  expect(first.node.textContent).toBe("Loading");
});

test("one update reaches multiple readers through one request without a spurious follow-up", async () => {
  const calls = captureFetches();
  await mount("worker");
  await mount("modal");
  await act(async () => calls[0]!.resolve(response()));
  await act(async () => updated("unrelated"));
  expect(calls).toHaveLength(1);
  await act(async () => updated());
  expect(calls).toHaveLength(2);
  await act(async () => calls[1]!.resolve(response("one", "Updated")));
  expect(calls).toHaveLength(2);
  expect(values.get("worker")!.canvas?.title).toBe("Updated");
  expect(values.get("modal")!.canvas?.title).toBe("Updated");
});

test("updates and reconnects during download share one follow-up and completed results make progress", async () => {
  const calls = captureFetches();
  const worker = await mount("worker");
  await mount("modal");
  await act(async () => { for (let i = 0; i < 20; i++) updated(); reconnect(); });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal.aborted).toBe(false);
  await act(async () => calls[0]!.resolve(response("one", "Interim")));
  expect(calls).toHaveLength(2);
  expect(worker.node.textContent).toBe("Interim");
  expect(values.get("worker")!.loading).toBe(true);
  await act(async () => { updated(); updated(); });
  await act(async () => calls[1]!.resolve(response("one", "Next")));
  expect(calls).toHaveLength(3);
  expect(worker.node.textContent).toBe("Next");
  await act(async () => calls[2]!.resolve(response("one", "Latest")));
  expect(calls).toHaveLength(3);
  expect(values.get("modal")!.canvas?.title).toBe("Latest");
  expect(values.get("worker")!.loading).toBe(false);
  expect(calls.every((call) => !call.signal.aborted)).toBe(true);
});

test("sharing lasts through body download and parsing, not just response headers", async () => {
  const calls = captureFetches();
  await mount("worker");
  let body: ReadableStreamDefaultController<Uint8Array>;
  await act(async () => calls[0]!.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }))));
  await mount("modal");
  await act(async () => updated());
  expect(calls).toHaveLength(1);
  await act(async () => { body.enqueue(new TextEncoder().encode(JSON.stringify({ canvas: document() }))); body.close(); });
  expect(calls).toHaveLength(2);
  await act(async () => calls[1]!.resolve(response("one", "Latest")));
  expect(values.get("modal")!.canvas?.title).toBe("Latest");
});

test("the final reader leaving cancels work and late results cannot reach a remounted reader", async () => {
  const calls = captureFetches();
  const first = await mount("first");
  await act(async () => updated());
  await first.close();
  expect(calls[0]!.signal.aborted).toBe(true);
  await act(async () => { updated(); reconnect(); });
  expect(calls).toHaveLength(1);
  const next = await mount("next");
  await act(async () => calls[1]!.resolve(response("one", "New lifetime")));
  await act(async () => calls[0]!.resolve(response("one", "Late")));
  expect(next.node.textContent).toBe("New lifetime");
  expect(calls).toHaveLength(2);
});

test("changing Canvas IDs hides the previous document and rejects late responses", async () => {
  const calls = captureFetches();
  const view = await mount("view");
  await act(async () => calls[0]!.resolve(response()));
  await act(async () => updated());
  await view.render("two");
  expect(view.node.textContent).toBe("Loading");
  expect(calls[1]!.signal.aborted).toBe(true);
  await act(async () => calls[2]!.resolve(response("two", "Second")));
  await act(async () => calls[1]!.resolve(response("one", "Old")));
  expect(view.node.textContent).toBe("Second");
});

test("transient failures preserve existing documents and a later refresh recovers", async () => {
  const calls = captureFetches();
  await mount("view");
  await act(async () => calls[0]!.resolve(response()));
  await act(async () => updated());
  await act(async () => calls[1]!.reject(new Error("Offline")));
  expect(values.get("view")!.canvas?.title).toBe("Original");
  expect(values.get("view")!.error).toBe("Offline");
  await act(async () => values.get("view")!.refresh());
  await act(async () => calls[2]!.resolve(response("one", "Recovered")));
  expect(values.get("view")!.error).toBeNull();
  expect(values.get("view")!.canvas?.title).toBe("Recovered");
});

for (const status of [401, 403, 404, 410]) {
  test(`HTTP ${status} removes inaccessible content even if its error body is not JSON`, async () => {
    const calls = captureFetches();
    await mount("view");
    await act(async () => calls[0]!.resolve(response()));
    await act(async () => updated());
    await act(async () => calls[1]!.resolve(new Response("Unavailable", { status })));
    expect(values.get("view")!.canvas).toBeNull();
    expect(values.get("view")!.error).toBeTruthy();
  });
}

test("a failed request still drains an update that arrived during the download", async () => {
  const calls = captureFetches();
  await mount("view");
  await act(async () => updated());
  await act(async () => calls[0]!.resolve(Response.json({ error: "Unavailable" }, { status: 503 })));
  expect(calls).toHaveLength(2);
  await act(async () => calls[1]!.resolve(response()));
  expect(values.get("view")!.canvas?.title).toBe("Original");
  expect(values.get("view")!.loading).toBe(false);
});

test("inaccessible content is cleared as soon as headers arrive, before the error body finishes", async () => {
  const calls = captureFetches();
  await mount("view");
  await act(async () => calls[0]!.resolve(response()));
  await act(async () => updated());
  let body: ReadableStreamDefaultController<Uint8Array>;
  await act(async () => calls[1]!.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { status: 403 })));
  expect(values.get("view")!.canvas).toBeNull();
  expect(values.get("view")!.loading).toBe(true);
  await act(async () => { body.enqueue(new TextEncoder().encode('{"error":"Forbidden"}')); body.close(); });
  expect(values.get("view")!.error).toBe("Forbidden");
  expect(values.get("view")!.loading).toBe(false);
});

test("manual frame reset affects only its caller while the document request stays shared", async () => {
  const calls = captureFetches();
  await mount("worker");
  await mount("modal");
  await act(async () => calls[0]!.resolve(response()));
  await act(async () => values.get("modal")!.refresh(true));
  expect(values.get("worker")!.canvas?.title).toBe("Original");
  expect(values.get("modal")!.canvas).toBeNull();
  expect(calls).toHaveLength(2);
  await act(async () => calls[1]!.resolve(response()));
  expect(values.get("modal")!.canvas?.title).toBe("Original");
});

test("a new reader after completion revalidates instead of adding a completed-document cache", async () => {
  const calls = captureFetches();
  const worker = await mount("worker");
  await act(async () => calls[0]!.resolve(response()));
  await mount("modal");
  expect(calls).toHaveLength(2);
  expect(worker.node.textContent).toBe("Original");
});

test("StrictMode cleanup leaves a fresh request that can complete", async () => {
  const calls = captureFetches();
  const view = await mount("view", "one", true);
  expect(calls.map((call) => call.signal.aborted)).toEqual([true, false]);
  await act(async () => calls[1]!.resolve(response()));
  await act(async () => calls[0]!.resolve(response("one", "Late")));
  expect(view.node.textContent).toBe("Original");
  expect(values.get("view")!.loading).toBe(false);
});
