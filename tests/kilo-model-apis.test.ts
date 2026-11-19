import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearKiloModelApis,
  kiloApiOfTag,
  kiloModelApi
} from "../src/server/config/kilo-model-apis.js";
import { createKiloModelApisRefresher } from "../src/server/modules/llm/kilo-model-apis-refresh.js";
import type { ProviderConfig } from "../src/server/config.js";
import { tempDir } from "./helpers/temp.js";

// Kilo's own /models list tags each model with the SDK its client should use
// (opencode.ai_sdk_provider). Mandate keeps those tags per connection, saved
// for restarts and refreshed, and runs an untagged or unknown model as Chat.

afterEach(() => clearKiloModelApis());

const KILO: ProviderConfig = { type: "kilo", baseURL: "https://gateway.example/api/gateway", apiKey: "k-test", organizationId: "org-test", models: [] };
const LISTING = { data: [{ id: "vendor/model-a", opencode: { ai_sdk_provider: "anthropic" } }, { id: "vendor/model-b" }, { id: "vendor/model-c", opencode: { ai_sdk_provider: "openai" } }] };

function fakeHttp(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  return {
    calls,
    http: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
        calls.push({ url: String(input), headers });
        const answer = answers[Math.min(i++, answers.length - 1)]!;
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
      }
    }
  };
}

test("tag mapping: Kilo's tag picks the API, anything else is Chat", () => {
  expect(kiloApiOfTag("anthropic")).toBe("messages");
  expect(kiloApiOfTag("openai")).toBe("responses");
  expect(kiloApiOfTag("openai-compatible")).toBe("chat");
  expect(kiloApiOfTag(undefined)).toBe("chat");
  expect(kiloApiOfTag("something-new")).toBe("chat");
});

test("unknown model resolves to chat", () => {
  expect(kiloModelApi("kilo", "anthropic/claude-opus-5.5")).toBe("chat");
});

test("a changed tag triggers one reload; an unchanged refresh does not", async () => {
  const { http } = fakeHttp([{ status: 200, body: LISTING }]);
  let changes = 0;
  const refresher = createKiloModelApisRefresher({ dataDir: tempDir(), http, providers: () => ({ kilo: KILO }), onChange: () => { changes++; } });
  await refresher.refresh();
  expect(changes).toBe(1);
  expect(kiloModelApi("kilo", "vendor/model-a")).toBe("messages");
  expect(kiloModelApi("kilo", "vendor/model-b")).toBe("chat");
  expect(kiloModelApi("kilo", "vendor/model-c")).toBe("responses");
  await refresher.refresh();
  expect(changes).toBe(1);
  refresher.dispose();
});

test("a failed listing keeps the last answer", async () => {
  const { http } = fakeHttp([{ status: 200, body: LISTING }, { status: 500, body: { error: "down" } }]);
  let changes = 0;
  const refresher = createKiloModelApisRefresher({ dataDir: tempDir(), http, providers: () => ({ kilo: KILO }), onChange: () => { changes++; } });
  await refresher.refresh();
  await refresher.refresh();
  expect(changes).toBe(1);
  expect(kiloModelApi("kilo", "vendor/model-a")).toBe("messages");
  refresher.dispose();
});

test("the saved map is restored at load, without the network", async () => {
  const dataDir = tempDir();
  const { http } = fakeHttp([{ status: 200, body: LISTING }]);
  const first = createKiloModelApisRefresher({ dataDir, http, providers: () => ({ kilo: KILO }), onChange: () => {} });
  await first.refresh();
  first.dispose();
  expect(JSON.parse(readFileSync(join(dataDir, "kilo-model-apis.json"), "utf8"))).toBeTruthy();
  clearKiloModelApis();
  const offline = fakeHttp([{ status: 500, body: {} }]);
  let changes = 0;
  const second = createKiloModelApisRefresher({ dataDir, http: offline.http, providers: () => ({ kilo: KILO }), onChange: () => { changes++; } });
  await second.load();
  expect(kiloModelApi("kilo", "vendor/model-a")).toBe("messages");
  expect(changes).toBe(1);
  expect(offline.calls).toHaveLength(0);
  second.dispose();
});

test("the request: the connection's models list, Bearer key and organisation", async () => {
  const { http, calls } = fakeHttp([{ status: 200, body: LISTING }]);
  const refresher = createKiloModelApisRefresher({
    dataDir: tempDir(),
    http,
    providers: () => ({ kilo: KILO, other: { type: "openai-compatible", baseURL: "https://other.example/v1", apiKey: "x", models: [] }, keyless: { ...KILO, apiKey: "" } }),
    onChange: () => {}
  });
  await refresher.refresh();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://gateway.example/api/gateway/models");
  expect(calls[0]!.headers.authorization).toBe("Bearer k-test");
  expect(calls[0]!.headers["x-kilocode-organizationid"]).toBe("org-test");
  refresher.dispose();
});

// The reload a change sets off can fail (a config that no longer loads); the
// tags are still taken and saved, and the daily refresh still starts.
test("a reload that throws neither loses the tags nor stops the refreshes", async () => {
  const dataDir = tempDir();
  const { http } = fakeHttp([{ status: 200, body: LISTING }]);
  const onChange = () => { throw new Error("config does not load"); };
  const refresher = createKiloModelApisRefresher({ dataDir, http, providers: () => ({ kilo: KILO }), onChange });
  await refresher.refresh();
  expect(kiloModelApi("kilo", "vendor/model-a")).toBe("messages");
  expect(JSON.parse(readFileSync(join(dataDir, "kilo-model-apis.json"), "utf8")).apis).toBeTruthy();
  refresher.dispose();
  clearKiloModelApis();
  const again = createKiloModelApisRefresher({ dataDir, http, providers: () => ({ kilo: KILO }), onChange });
  await again.load();
  expect(kiloModelApi("kilo", "vendor/model-a")).toBe("messages");
  again.dispose();
});
