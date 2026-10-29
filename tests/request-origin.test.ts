import { expect, test } from "bun:test";
import { buildApp } from "../src/server/app/http-app.js";
import type { AppDeps } from "../src/server/app/deps.js";
import { formatStartupOriginLines } from "../src/server/app/startup-log.js";
import { loadConfig, type JsonObject } from "../src/server/config.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";

// A browser attaches `Origin` to every cross-site write and to every WebSocket
// handshake, and a page cannot change it. A write or a handshake whose Origin
// is neither this server's own address nor a known local one comes from
// another site open in the user's browser, and is refused before its handler.

function fixture(config: Record<string, unknown> = {}) {
  const env = freshAgentEnv("mandate-request-origin-");
  const deps = {
    config: {
      agent: { compressionThresholdTokens: 100000 },
      retention: { chatRetentionDays: 90, chatMaxTableBytes: 512 * 1024 * 1024, chatToolResultHeadChars: 2000 },
      ...config
    },
    agentStore: env.agentStore, store: env.store, scopes: { manager: {} }, sse: new AgentSseEmitter(),
    getSnapshot: () => null, getProjectsState: () => [], heartbeatMs: 60000
  } as unknown as AppDeps;
  return { ...env, ...buildApp(deps) };
}

/** A write to the server as reached at `at`, from a page at `origin`. */
function write(app: ReturnType<typeof fixture>["app"], at: string, origin?: string, more: Record<string, string> = {}) {
  return app.request(`${at}/api/storage/cleanup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { Origin: origin } : {}), ...more },
    body: "{}"
  });
}

const HERE = "http://127.0.0.1:4175";

test("a write from another site is refused, and says why", async () => {
  const env = fixture();
  try {
    const refused = await write(env.app, HERE, "https://elsewhere.example");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Refused: this request was sent by a page of another site." });
    // An opaque origin (a sandboxed frame, a file) is another site too.
    expect((await write(env.app, HERE, "null")).status).toBe(403);
    // Every method that changes something, on any route, found or not.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await env.app.request(`${HERE}/api/nowhere`, { method, headers: { Origin: "https://elsewhere.example" } });
      expect([method, res.status]).toEqual([method, 403]);
    }
  } finally { env.cleanup(); }
});

test("a write from the server's own page, a local one or the desktop app goes through as before", async () => {
  const env = fixture();
  try {
    const plain = (await write(env.app, HERE)).status;
    expect(plain).not.toBe(403);
    const accepted: Array<[string, string, Record<string, string>?]> = [
      // The page this server served, at whatever address it is reached.
      [HERE, "http://127.0.0.1:4175"],
      ["http://192.168.1.20:4173", "http://192.168.1.20:4173"],
      ["http://mandate.example:7007", "http://mandate.example:7007"],
      ["http://[::1]:4173", "http://[::1]:4173"],
      // A scheme's default port, written out on one side and left off on the other.
      ["http://mandate.example", "http://mandate.example:80"],
      ["http://mandate.example", "http://MANDATE.example"],
      [HERE, "http://mandate.example", { Host: "mandate.example:80" }],
      [HERE, "https://mandate.example", { Host: "MANDATE.example:443" }],
      // Behind a proxy that ends TLS and passes Host on: the server cannot know
      // its public scheme, so the page's own is taken.
      ["http://mandate.example", "https://mandate.example"],
      ["http://mandate.example", "https://mandate.example:443"],
      // A dev server on another local port, and the desktop app's own origins.
      [HERE, "http://localhost:4173"],
      [HERE, "tauri://localhost"],
      [HERE, "http://tauri.localhost"]
    ];
    for (const [at, origin, more] of accepted) {
      expect([origin, (await write(env.app, at, origin, more)).status]).toEqual([origin, plain]);
    }
    // The same host on another port is another server's page.
    expect((await write(env.app, "http://mandate.example:7007", "http://mandate.example:9000")).status).toBe(403);
    expect((await write(env.app, "http://mandate.example", "https://mandate.example:8443")).status).toBe(403);
    // What a request says a proxy was asked for vouches for nothing: the sender
    // writes those headers. Only the Host the request arrived with counts.
    const forwarded = { "X-Forwarded-Host": "mandate.example:7007", "X-Forwarded-Proto": "http" };
    expect((await write(env.app, HERE, "http://mandate.example:7007", forwarded)).status).toBe(403);
    expect((await write(env.app, HERE, "https://elsewhere.example", { "X-Forwarded-Host": "elsewhere.example" })).status).toBe(403);
  } finally { env.cleanup(); }
});

test("a read is not refused by its origin: the browser already keeps another site from reading the answer", async () => {
  const env = fixture();
  try {
    const plain = await env.app.request(`${HERE}/api/agents/manager/threads`);
    const foreign = await env.app.request(`${HERE}/api/agents/manager/threads`, { headers: { Origin: "https://elsewhere.example" } });
    expect(foreign.status).toBe(plain.status);
    expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
  } finally { env.cleanup(); }
});

test("a terminal handshake from another site is refused; the server's own page may open one", async () => {
  const env = fixture();
  try {
    const handshake = (at: string, origin: string, more: Record<string, string> = {}) => env.app.request(`${at}/api/terminal?paneId=%251`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade", Origin: origin, ...more }
    });
    expect((await handshake(HERE, "https://elsewhere.example")).status).toBe(403);
    expect((await handshake(HERE, "http://127.0.0.1:4175")).status).not.toBe(403);
    // Through a proxy or tunnel that passes Host on, plain or ending TLS.
    expect((await handshake("http://mandate.example:7007", "http://mandate.example:7007")).status).not.toBe(403);
    expect((await handshake("http://mandate.example", "https://mandate.example")).status).not.toBe(403);
    // A forwarded host does not open it.
    expect((await handshake(HERE, "http://192.168.1.20:4173", { "X-Forwarded-Host": "192.168.1.20:4173" })).status).toBe(403);
  } finally { env.cleanup(); }
});

test("the check can be turned off in the config file or by the environment, and the server says so at start", async () => {
  const off = fixture({ checkOrigin: false });
  try {
    expect((await write(off.app, HERE, "https://elsewhere.example")).status).toBe((await write(off.app, HERE)).status);
  } finally { off.cleanup(); }

  const load = (file: JsonObject) => loadConfig(undefined, new MemoryJsonStore<JsonObject>(file));
  const before = process.env.MANDATE_CHECK_ORIGIN;
  try {
    delete process.env.MANDATE_CHECK_ORIGIN;
    expect(load({}).checkOrigin).toBe(true);
    expect(load({ checkOrigin: false }).checkOrigin).toBe(false);
    // Anything but a boolean in the file is not a way to turn it off.
    expect(load({ checkOrigin: "no" }).checkOrigin).toBe(true);
    process.env.MANDATE_CHECK_ORIGIN = "0";
    expect(load({}).checkOrigin).toBe(false);
    process.env.MANDATE_CHECK_ORIGIN = "1";
    expect(load({ checkOrigin: false }).checkOrigin).toBe(true);
  } finally {
    if (before === undefined) delete process.env.MANDATE_CHECK_ORIGIN;
    else process.env.MANDATE_CHECK_ORIGIN = before;
  }

  expect(formatStartupOriginLines({ checkOrigin: true })).toEqual([]);
  expect(formatStartupOriginLines({ checkOrigin: false })).toEqual([
    "Origin check is off: a page of any site open in a browser on this machine can send requests to Mandate."
  ]);
});
