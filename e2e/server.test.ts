import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer, type RunningServer } from "./helpers/server.js";

/**
 * What the binary does that `buildApp().request()` cannot show: it serves the
 * client from a map embedded at compile time, negotiates encodings, and binds
 * a port. Nothing in the unit tier reaches any of that, so a build that
 * embedded nothing would pass every one of those 1569 tests.
 */

let server: RunningServer;

beforeAll(async () => { server = await startServer(); });
afterAll(() => { server?.cleanup(); });

const get = (pathname: string, init?: RequestInit) =>
  fetch(`${server.baseUrl}${pathname}`, init);

describe("the compiled binary serves its embedded client", () => {
  test("/ returns the built index rather than a 404", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Mandate</title>");
    // A build that embedded the map but not the bundle would still return
    // HTML, so pin that the document actually references a built asset.
    expect(html).toMatch(/<script[^>]+src="\/assets\/[^"]+\.js"/);
  });

  test("the asset the index names is really there", async () => {
    const html = await (await get("/")).text();
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(asset).toBeTruthy();
    const res = await get(asset!);
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(1000);
  });
});

describe("cache policy follows what is served, not what was asked for", () => {
  test("a hashed asset is immutable", async () => {
    const html = await (await get("/")).text();
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)![1];
    expect((await get(asset)).headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
  });

  test("the index is not", async () => {
    expect((await get("/")).headers.get("cache-control")).toBe("no-cache");
  });

  test("an unknown path under /assets/ falls back to the index and loses immutability", async () => {
    // The trap this pins: keying the cache header off the REQUESTED path would
    // hand a year-long immutable cache to an SPA fallback, and every client
    // that hit a stale asset URL once would be stuck on that HTML.
    const res = await get("/assets/does-not-exist-abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Mandate</title>");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("an unknown route serves the app so client-side routing can take it", async () => {
    const res = await get("/memory/browse");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Mandate</title>");
  });
});

describe("over a real socket", () => {
  test("responses are compressed when the client offers it", async () => {
    // compress() sits in the middleware chain but never runs in-process,
    // because nothing there negotiates an encoding.
    const res = await get("/", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  test("the api answers on the bound port", async () => {
    const res = await get("/api/settings/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("an unknown api path is a 404 and not the html fallback", async () => {
    // Static serving is mounted on /* after the api routes, so a typo'd api
    // path returning index.html would read as a working endpoint to a caller
    // that only checks the status.
    const res = await get("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<title>Mandate</title>");
  });
});
