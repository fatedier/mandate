import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";

test("SSE activity replaces info polling and a silent stream reconnects even while HTTP is healthy", async () => {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const frame = (event: string, data: unknown) => new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
  let connections = 0;
  let holdBootstrap = false;
  let bootstrap: Uint8Array;
  const fixture = startWorkspaceFixture(undefined, () => {
    connections++;
    let client: ReadableStreamDefaultController<Uint8Array>;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        client = controller;
        clients.add(client);
        if (!holdBootstrap) client.enqueue(bootstrap);
      },
      cancel() { clients.delete(client); }
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  });
  const emit = (event: string, data: unknown) => {
    for (const client of clients) client.enqueue(frame(event, data));
  };
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  // Observe delivery independently of React state, so advancing browser time
  // never races an SSE frame that is still in the real network queue.
  await page.addInitScript(() => {
    const NativeSource = window.EventSource;
    (window as any).__sseFrames = 0;
    window.EventSource = class extends NativeSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        for (const name of ["_hb", "projectReordered"]) {
          this.addEventListener(name, () => { (window as any).__sseFrames++; });
        }
      }
    };
  });
  const waitUntil = async (condition: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the browser transport");
  };
  const send = async (event: string, data: unknown) => {
    const before = await page.evaluate(() => (window as any).__sseFrames as number);
    emit(event, data);
    await waitUntil(async () => await page.evaluate(() => (window as any).__sseFrames as number) > before);
  };
  try {
    // Read only the isolated fixture, before browser request accounting starts.
    const state = await (await page.request.get(fixture.baseUrl + "/api/state")).json() as { snapshot: unknown; projects: unknown };
    bootstrap = new TextEncoder().encode(
      new TextDecoder().decode(frame("snapshot", state.snapshot)) +
      new TextDecoder().decode(frame("projectsState", state.projects)) +
      new TextDecoder().decode(frame("_hb", { intervalMs: 10000 }))
    );
    await page.clock.install({ time: new Date("2026-09-13T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-09-13T00:00:01Z"));
    await page.goto(fixture.baseUrl + "/projects");
    await page.getByText("Worker pane zoom", { exact: true }).first().waitFor();
    await waitUntil(async () => await page.evaluate(() => (window as any).__sseFrames as number) > 0);

    // Six normal heartbeats cover one idle minute with zero readiness probes.
    for (let i = 0; i < 6; i++) {
      await page.clock.runFor(10000);
      await send("_hb", { intervalMs: 10000 });
    }
    expect(connections).toBe(1);
    expect(requests).not.toContain("/api/info");

    // Any domain frame is transport activity, including events without a
    // local store handler. It extends the deadline just like a heartbeat.
    await page.clock.runFor(19000);
    await send("projectReordered", { ids: [] });
    await page.clock.runFor(19000);
    expect(connections).toBe(1);

    // Leave the TCP stream open but stop all frames. HTTP still returns 200.
    expect((await page.request.get(fixture.baseUrl + "/api/info")).status()).toBe(200);
    holdBootstrap = true;
    await page.clock.runFor(1001);
    await waitUntil(() => connections === 2);
    await waitUntil(() => clients.size === 1);
    await page.clock.runFor(2100);
    expect(await page.getByText("Reconnecting…", { exact: true }).isVisible()).toBe(true);
    expect(requests).not.toContain("/api/info");

    const refetches = requests.filter((url) => url === "/api/agents/active-wakes").length;
    holdBootstrap = false;
    for (const client of clients) client.enqueue(bootstrap);
    await waitUntil(() => requests.filter((url) => url === "/api/agents/active-wakes").length > refetches);
    expect(await page.getByText("Reconnecting…", { exact: true }).isVisible()).toBe(false);

    // A configured longer heartbeat interval must not cause a reconnect loop.
    await send("_hb", { intervalMs: 60000 });
    await page.clock.runFor(60000);
    expect(connections).toBe(2);
    await send("_hb", { intervalMs: 60000 });
    expect(requests).not.toContain("/api/info");
    await page.close();
    await waitUntil(() => clients.size === 0);
  } finally {
    await browser.close();
    fixture.stop();
  }
}, 30000);
