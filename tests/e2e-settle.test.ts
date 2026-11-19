import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { Page } from "playwright";
import { trackRequests } from "../e2e/helpers/settle.js";

// The wait the touch-target checks make before they measure a page: until no
// request is in flight and every stream has its initial state. It gave up
// with "still loading after 5s" milliseconds into a wait, naming a request
// that had begun a moment before: once the page looked idle it read the page
// a second time, and took a request begun between the two readings for one
// that had outlasted the five seconds. A page that searches as its address
// changes begins such a request just then.

afterEach(() => setSystemTime());

type Handler = (request: unknown) => void;

/** A page as the wait sees it: the events it listens to, and its reads of
 *  the page, each of which finds every stream with its initial state.
 *  `beforeRead` runs as each read is made, with its number from 1; a promise
 *  it returns holds that read until it resolves. A wait that never ends is
 *  stopped at its hundredth read, so it fails and says so. */
function fakePage(beforeRead: (read: number, page: { begin(url: string): unknown; end(request: unknown): void }) => void | Promise<void> = () => {}) {
  const handlers = new Map<string, Handler[]>();
  const emit = (name: string, request: unknown) => { for (const handler of handlers.get(name) ?? []) handler(request); };
  const control = {
    begin(url: string) {
      const request = { resourceType: () => "fetch", url: () => url };
      emit("request", request);
      return request;
    },
    end(request: unknown) { emit("requestfinished", request); },
    fail(request: unknown) { emit("requestfailed", request); }
  };
  let reads = 0;
  const page = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async addInitScript() {},
    async evaluate() {
      reads += 1;
      if (reads > 100) throw new Error("the wait read the page a hundred times without ending");
      await beforeRead(reads, control);
      return { opened: 1, hydrated: 1 };
    }
  };
  return { page: page as unknown as Page, control, reads: () => reads };
}

test("a request that begins just after the page first looks idle is waited for, not taken for five seconds of loading", async () => {
  let late: unknown = null;
  const { page, control } = fakePage((read, at) => {
    // The first reading finds the page idle. A search goes out before the
    // second, and is answered a moment later.
    if (read === 2) {
      late = at.begin("http://127.0.0.1:1/api/memory/entries?q=project-1");
      setTimeout(() => control.end(late), 60);
    }
  });
  const requests = await trackRequests(page);
  const began = performance.now();
  await requests.idle();
  const waited = performance.now() - began;
  expect(late).not.toBeNull();
  // It waited for the answer, and nowhere near the five seconds.
  expect(waited).toBeGreaterThanOrEqual(50);
  expect(waited).toBeLessThan(2000);
});

test("a request begun while the page settles is waited for too", async () => {
  const { page, control, reads } = fakePage((read, at) => {
    // Reads: 1 idle; 2 is the settle itself, during which a response starts
    // another request; it ends after a few more readings.
    if (read === 2) {
      const next = at.begin("http://127.0.0.1:1/api/activity/calls?limit=20");
      setTimeout(() => control.end(next), 60);
    }
  });
  const requests = await trackRequests(page);
  await requests.idle();
  // The idle reading, the settle, the readings while the request was in
  // flight, then a settle and a last idle reading.
  expect(reads()).toBeGreaterThan(4);
});

test("a request still in flight after five seconds is named, with the streams' state", async () => {
  const { page, control } = fakePage((read) => {
    // Five seconds pass on the clock while the request stays in flight.
    if (read === 3) setSystemTime(new Date(Date.now() + 5001));
  });
  const requests = await trackRequests(page);
  control.begin("http://127.0.0.1:1/api/activity/summary?range=7d");
  await expect(requests.idle()).rejects.toThrow("still loading after 5s: http://127.0.0.1:1/api/activity/summary?range=7d in flight, 1/1 streams with their initial state");
});

test("a request still in flight just short of the five seconds is waited for, and not reported when it then ends", async () => {
  let slow: unknown = null;
  let began = 0;
  let foundInFlightLate = false;
  const { page, control } = fakePage((read) => {
    // Found still in flight with ten milliseconds of the five seconds left...
    if (read === 2) {
      setSystemTime(new Date(began + 4990));
      foundInFlightLate = true;
    }
    // ...and answered by the next reading, with the five seconds gone.
    if (read === 3) {
      setSystemTime(new Date(began + 6000));
      control.end(slow);
    }
  });
  const requests = await trackRequests(page);
  slow = control.begin("http://127.0.0.1:1/api/activity/summary?range=7d");
  // The wait's five seconds begin no earlier than this.
  began = Date.now();
  await requests.idle();
  expect(foundInFlightLate).toBe(true);
});

test("a request that fails is no longer in flight, as one that is answered", async () => {
  const { page, control } = fakePage((read) => {
    if (read === 2) control.fail(aborted);
  });
  const requests = await trackRequests(page);
  const aborted = control.begin("http://127.0.0.1:1/api/memory/entries?q=pro");
  await requests.idle();
});

test("with nothing in flight it returns once the page has settled, and not before", async () => {
  // The second read is the settle: what is moving on the page is still moving
  // until it is let go.
  let letGo!: () => void;
  const moving = new Promise<void>((resolve) => { letGo = resolve; });
  const { page, reads } = fakePage((read) => (read === 2 ? moving : undefined));
  const requests = await trackRequests(page);
  let returned = false;
  const waiting = requests.idle().then(() => { returned = true; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect([returned, reads()]).toEqual([false, 2]);
  letGo();
  await waiting;
  // An idle reading, the settle, and an idle reading after it.
  expect([returned, reads()]).toEqual([true, 3]);
});
