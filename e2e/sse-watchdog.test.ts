import { expect, test } from "bun:test";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { sseFrame } from "../tests/helpers/sse";
import { waitUntil } from "../tests/helpers/wait";

const browser = browserForFile();

/** The page's window with the frame counter its init script adds. */
type CountingWindow = typeof window & { __sseFrames: number };

test("SSE activity replaces info polling and a silent stream reconnects even while HTTP is healthy", async () => {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const frame = (event: string, data: unknown) => new TextEncoder().encode(sseFrame({ event, data }));
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
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  // Observe delivery independently of React state, so advancing browser time
  // never races an SSE frame that is still in the real network queue.
  await page.addInitScript(() => {
    const NativeSource = window.EventSource;
    (window as CountingWindow).__sseFrames = 0;
    window.EventSource = class extends NativeSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        for (const name of ["_hb", "projectReordered"]) {
          this.addEventListener(name, () => { (window as CountingWindow).__sseFrames++; });
        }
      }
    };
  });
  // Each step of the browser transport gets two seconds, polled every 10ms.
  const transport = { timeout: 2000, interval: 10 };
  const send = async (event: string, data: unknown) => {
    const before = await page.evaluate(() => (window as CountingWindow).__sseFrames);
    emit(event, data);
    await waitUntil(async () => await page.evaluate(() => (window as CountingWindow).__sseFrames) > before, { ...transport, label: `the page to receive ${event}` });
  };
  try {
    // Read only the isolated fixture, before browser request accounting starts.
    const state = await (await page.request.get(fixture.baseUrl + "/api/state")).json() as { snapshot: unknown; projects: unknown };
    bootstrap = new TextEncoder().encode(
      sseFrame({ event: "snapshot", data: state.snapshot }) +
      sseFrame({ event: "projectsState", data: state.projects }) +
      sseFrame({ event: "_hb", data: { intervalMs: 10000 } })
    );
    await page.clock.install({ time: new Date("2026-09-13T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-09-13T00:00:01Z"));
    await page.goto(fixture.baseUrl + "/projects");
    await page.getByText("Worker pane zoom", { exact: true }).first().waitFor();
    await waitUntil(async () => await page.evaluate(() => (window as CountingWindow).__sseFrames) > 0, { ...transport, label: "the page's first heartbeat" });

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

    // Where the header's actions sit while connected (absent: an empty slot hides).
    const header = page.locator('[data-slot="pane-header"]');
    const actionsBefore = await header.locator('[data-slot="pane-actions"]').boundingBox();

    // Leave the TCP stream open but stop all frames. HTTP still returns 200.
    expect((await page.request.get(fixture.baseUrl + "/api/info")).status()).toBe(200);
    holdBootstrap = true;
    await page.clock.runFor(1001);
    await waitUntil(() => connections === 2, { ...transport, label: "a second connection" });
    await waitUntil(() => clients.size === 1, { ...transport, label: "one open stream" });
    await page.clock.runFor(2100);
    // Said in the header, straight after the title, which stays whole; the
    // actions do not move. The indicator also carries a screen-reader copy of
    // the word, so read the visible one.
    const word = header.locator('[data-slot="connection-word"]');
    expect([await word.isVisible(), await word.textContent()]).toEqual([true, "Reconnecting…"]);
    const title = header.locator('[data-slot="pane-default-title"]');
    // Where the title's visible text ends, not its box, which could stretch.
    const titleRight = await title.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Math.min(range.getBoundingClientRect().right, node.getBoundingClientRect().right);
    });
    const saidBox = (await header.locator('[data-slot="connection-indicator"]').boundingBox())!;
    const gap = saidBox.x - titleRight;
    expect(gap >= 0 && gap < 16).toBe(true);
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await header.locator('[data-slot="pane-actions"]').boundingBox()).toEqual(actionsBefore);
    expect(requests).not.toContain("/api/info");

    const refetches = requests.filter((url) => url === "/api/agents/active-wakes").length;
    holdBootstrap = false;
    for (const client of clients) client.enqueue(bootstrap);
    await waitUntil(() => requests.filter((url) => url === "/api/agents/active-wakes").length > refetches, { ...transport, label: "active wakes refetched" });
    // Gone, the screen-reader copy included.
    expect(await page.getByText("Reconnecting…", { exact: true }).count()).toBe(0);

    // A configured longer heartbeat interval must not cause a reconnect loop.
    await send("_hb", { intervalMs: 60000 });
    await page.clock.runFor(60000);
    expect(connections).toBe(2);
    await send("_hb", { intervalMs: 60000 });
    expect(requests).not.toContain("/api/info");
    await page.close();
    await waitUntil(() => clients.size === 0, { ...transport, label: "no open stream" });
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30000);
