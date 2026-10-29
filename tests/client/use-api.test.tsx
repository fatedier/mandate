import { expect, test } from "bun:test";
import { act } from "react";
import { useApi } from "@/hooks/useApi";
import { useSnapshotStore } from "@/store/snapshot";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, type Mounted } from "../helpers/mount.js";

async function withRequest(
  fetchResponse: () => Promise<Response>,
  run: (request: ReturnType<typeof useApi>) => Promise<void>
) {
  const previousState = useSnapshotStore.getState();
  mockFetch(fetchResponse);
  useSnapshotStore.setState({ snapshot: null, banner: "", connection: "open" });
  let request!: ReturnType<typeof useApi>;
  function Probe() { request = useApi(); return null; }
  let view: Mounted | undefined;
  try {
    view = await mountAsync(<Probe />);
    await act(async () => { await run(request); });
  } finally {
    view?.unmount();
    useSnapshotStore.setState(previousState, true);
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

test("useApi leaves a pending banner alone when a response carries neither a snapshot nor an error", async () => {
  const payload = { sessions: [] };
  await withRequest(async () => Response.json(payload), async (request) => {
    useSnapshotStore.getState().setBanner("Inspection failed");
    expect(await request("GET", "/api/sessions")).toEqual(payload);
    expect(useSnapshotStore.getState().banner).toBe("Inspection failed");
  });
});
