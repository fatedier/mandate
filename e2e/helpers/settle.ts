import type { Page, Request } from "playwright";
import { SSE_HEARTBEAT_EVENT } from "../../src/shared/api/sse.js";

/** Waits out what is moving — a drawer sliding, a sheet rising or springing
 *  back — rather than a fixed pause: every finite animation or transition
 *  running once the last input's frame has painted. A spinner's never ends,
 *  so it is not waited on; two seconds caps the wait. */
export async function settle(page: Page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const moving = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.race([
      Promise.all(moving.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  });
}

/** What the page loads, tracked from before it loads: its fetch and XHR in
 *  flight, and whether each event stream it opened has delivered its initial
 *  state — the server writes that state, then its first heartbeat, so the
 *  first heartbeat marks the end (a stream never ends, so it is not a request
 *  in flight). A ready selector can be chrome that renders before the data
 *  under it; this is how a check waits for the data. Call before goto. */
export async function trackRequests(page: Page) {
  const inFlight = new Set<Request>();
  page.on("request", (request) => {
    const type = request.resourceType();
    if (type === "fetch" || type === "xhr") inFlight.add(request);
  });
  const done = (request: Request) => { inFlight.delete(request); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  // Listens on each stream the page opens; changes nothing it does.
  await page.addInitScript((heartbeat) => {
    const state = { opened: 0, hydrated: 0 };
    (window as unknown as { __streams: typeof state }).__streams = state;
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        state.opened += 1;
        this.addEventListener(heartbeat, () => { state.hydrated += 1; }, { once: true });
      }
    };
  }, SSE_HEARTBEAT_EVENT);
  const streams = () => page.evaluate(() =>
    (window as unknown as { __streams?: { opened: number; hydrated: number } }).__streams ?? { opened: 0, hydrated: 0 });
  const pending = async () => {
    const { opened, hydrated } = await streams();
    return inFlight.size > 0 || hydrated < opened;
  };
  return {
    /** Until nothing is in flight, every stream has its initial state, and the
     *  page has settled after that, again until all three hold at once, so a
     *  request a response starts is waited for too. Past five seconds it
     *  throws, naming what is still loading: measuring then would check a page
     *  without its data, and pass.
     *
     *  It gives up only on a reading that finds the page loading with the five
     *  seconds gone. Read again once it looked idle, the page was found
     *  loading by a request begun in between (its report of where it is, a
     *  search, as its address changes), and that was taken for the five
     *  seconds having passed. */
    async idle() {
      const deadline = Date.now() + 5000;
      for (;;) {
        while (await pending()) {
          if (Date.now() >= deadline) {
            const { opened, hydrated } = await streams();
            throw new Error(`still loading after 5s: ${[...inFlight].map((r) => r.url()).join(", ") || "no request"} in flight, ${hydrated}/${opened} streams with their initial state`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await settle(page);
        if (!(await pending())) return;
      }
    }
  };
}
