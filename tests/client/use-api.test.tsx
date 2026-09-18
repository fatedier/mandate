import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useApi } from "@/hooks/useApi";
import { useSnapshotStore } from "@/store/snapshot";

async function withRequest(
  fetchResponse: () => Promise<Response>,
  run: (request: ReturnType<typeof useApi>) => Promise<void>
) {
  const previousFetch = globalThis.fetch;
  const previousState = useSnapshotStore.getState();
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = fetchResponse as unknown as typeof fetch;
  useSnapshotStore.setState({ snapshot: null, banner: "", connection: "open" });
  let request!: ReturnType<typeof useApi>;
  function Probe() { request = useApi(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await run(request); });
  } finally {
    await act(async () => { root.unmount(); });
    useSnapshotStore.setState(previousState, true);
    globalThis.fetch = previousFetch;
    environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
}

test.each([
  { name: "HTTP failure", response: () => Response.json({ snapshot: { sessions: [] } }, { status: 500 }), message: "HTTP 500" },
  { name: "business failure", response: () => Response.json({ ok: false, error: "Inspection failed", snapshot: { sessions: [] } }), message: "Inspection failed" },
  { name: "bare error", response: () => Response.json({ error: "Window not found" }), message: "Window not found" },
  { name: "proxy error page", response: () => new Response("<html>Gateway error</html>", { status: 502 }), message: "HTTP 502" },
  { name: "invalid JSON", response: () => new Response("not json"), message: "Invalid JSON response" },
  { name: "null payload", response: () => Response.json(null), message: "Invalid API response" }
])("useApi displays $name without changing the connection or snapshot", async ({ response, message }) => {
  await withRequest(async () => response(), async (request) => {
    expect(await request("GET", "/api/state")).toBeNull();
    expect(useSnapshotStore.getState()).toMatchObject({ banner: message, connection: "open", snapshot: null });
  });
});

test("useApi still marks a fetch network failure as disconnected", async () => {
  await withRequest(async () => { throw new TypeError("Failed to fetch"); }, async (request) => {
    expect(await request("GET", "/api/state")).toBeNull();
    expect(useSnapshotStore.getState()).toMatchObject({ banner: "", connection: "error", snapshot: null });
  });
});

test("useApi applies successful snapshots and returns the response", async () => {
  const payload = { ok: true, snapshot: { sessions: [] } };
  await withRequest(async () => Response.json(payload), async (request) => {
    expect(await request("GET", "/api/state")).toEqual(payload);
    expect(useSnapshotStore.getState()).toMatchObject({ banner: "", connection: "open", snapshot: payload.snapshot });
  });
});
