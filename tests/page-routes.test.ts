import { expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { mountPageRoutes } from "../src/server/modules/page/page-routes.js";
import { API_PATHS, API_ROUTES } from "../src/shared/api-contracts.js";

let env: StoresEnv | null = null;

test("the page's state and its versions are read by revision; an unknown one is 404", async () => {
  env = freshStoresEnv("md-page-routes-");
  const pageStore = new PageStore(env.store.db);
  const app = new Hono();
  mountPageRoutes(app, { pageStore });
  expect(await (await app.request(API_ROUTES.agentPage)).json()).toEqual({ latest: null, write: null });
  pageStore.publish([{ path: "index.html", bytes: new TextEncoder().encode("<h1>Today</h1>") }], "agent");
  const state = await (await app.request(API_ROUTES.agentPage)).json() as { latest: { revision: number; writer: string } };
  expect(state.latest).toMatchObject({ revision: 1, writer: "agent" });
  expect(await (await app.request(API_PATHS.agentPageVersion(1))).json()).toMatchObject({ revision: 1, pages: { "index.html": "<h1>Today</h1>" } });
  for (const missing of ["/api/agent-page/versions/2", "/api/agent-page/versions/abc", "/api/agent-page/versions/1.5"]) {
    expect((await app.request(missing)).status).toBe(404);
  }
});

test("a version's files are read by path, each as what it is, sandboxed; what is not in it is 404", async () => {
  env = freshStoresEnv("md-page-routes-");
  const pageStore = new PageStore(env.store.db);
  const app = new Hono();
  mountPageRoutes(app, { pageStore });
  const enc = (body: string) => new TextEncoder().encode(body);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  pageStore.publish([
    { path: "index.html", bytes: enc("<h1>Today</h1>") },
    { path: "css/style.css", bytes: enc("h1{color:red}") },
    { path: "img/a dot.png", bytes: png }
  ], "agent");
  pageStore.publish([{ path: "index.html", bytes: enc("<h1>Later</h1>") }], "agent");
  const css = await app.request(`${API_PATHS.agentPageFilesBase(1)}css/style.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get("Content-Type")).toBe("text/css;charset=utf-8");
  // Opened in a tab of its own, a file could drive Mandate's API: it never runs.
  expect(css.headers.get("Content-Security-Policy")).toBe("sandbox");
  expect(css.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await css.text()).toBe("h1{color:red}");
  const image = await app.request(`${API_PATHS.agentPageFilesBase(1)}img/a%20dot.png`);
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...png]);
  // Each version's own: the later one has no stylesheet.
  expect(await (await app.request(`${API_PATHS.agentPageFilesBase(2)}index.html`)).text()).toBe("<h1>Later</h1>");
  for (const missing of [`${API_PATHS.agentPageFilesBase(2)}css/style.css`, `${API_PATHS.agentPageFilesBase(3)}index.html`, "/api/agent-page/files/abc/index.html", `${API_PATHS.agentPageFilesBase(1)}css%2F..%2Fcss%2Fstyle.css`, `${API_PATHS.agentPageFilesBase(1)}%E0%A4%A`]) {
    expect((await app.request(missing)).status).toBe(404);
  }
  // Asked again with its tag: not sent again.
  const tag = css.headers.get("ETag")!;
  expect((await app.request(`${API_PATHS.agentPageFilesBase(1)}css/style.css`, { headers: { "If-None-Match": tag } })).status).toBe(304);
});

test("a version from before the folder has its page as index.html, and nothing else", async () => {
  env = freshStoresEnv("md-page-routes-");
  const pageStore = new PageStore(env.store.db);
  env.store.db.prepare("insert into agent_page_versions (revision, html, writer, created_at) values (1, '<h1>Old</h1>', 'agent', '2026-11-01T00:00:00.000Z')").run();
  const app = new Hono();
  mountPageRoutes(app, { pageStore });
  expect(await (await app.request(API_PATHS.agentPageVersion(1))).json()).toMatchObject({ pages: { "index.html": "<h1>Old</h1>" } });
  expect(await (await app.request(`${API_PATHS.agentPageFilesBase(1)}index.html`)).text()).toBe("<h1>Old</h1>");
  expect((await app.request(`${API_PATHS.agentPageFilesBase(1)}style.css`)).status).toBe(404);
});

test("the scheduled updates are listed, paused, resumed and removed; an unknown one is 404", async () => {
  env = freshStoresEnv("md-page-routes-");
  const pageStore = new PageStore(env.store.db);
  const update = { name: "morning-summary", when: "0 9 * * *", whenText: "Daily 09:00", task: "Sum up yesterday.", paused: false, nextRunAt: null, lastRunAt: null, lastOutcome: null, lastError: null };
  let listed = [update];
  const app = new Hono();
  mountPageRoutes(app, {
    pageStore,
    updates: {
      list: () => listed,
      setPaused: (name, paused) => (name === update.name ? { ...update, paused } : null),
      remove: (name) => {
        const had = listed.some((u) => u.name === name);
        listed = listed.filter((u) => u.name !== name);
        return had;
      }
    }
  });
  expect(await (await app.request(API_ROUTES.agentPageUpdates)).json()).toEqual({ updates: [update] });
  const patch = (name: string, body: unknown) => app.request(API_PATHS.agentPageUpdate(name), { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  expect(await (await patch("morning-summary", { paused: true })).json()).toEqual({ update: { ...update, paused: true } });
  expect((await patch("morning-summary", { paused: "yes" })).status).toBe(400);
  expect((await patch("nobody", { paused: true })).status).toBe(404);
  expect(await (await app.request(API_PATHS.agentPageUpdate("morning-summary"), { method: "DELETE" })).json()).toEqual({ removed: true });
  expect((await app.request(API_PATHS.agentPageUpdate("morning-summary"), { method: "DELETE" })).status).toBe(404);
  // Without updates, none are listed.
  const bare = new Hono();
  mountPageRoutes(bare, { pageStore });
  expect(await (await bare.request(API_ROUTES.agentPageUpdates)).json()).toEqual({ updates: [] });
});
