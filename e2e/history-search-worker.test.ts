import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { assertStubProvider, respond, seedStubProvider, shown } from "./helpers/responses-stub.js";

/**
 * The compiled server's work in workers of their own (built entrypoints),
 * never through the fallbacks on the server's thread.
 *
 * chat_history_search: the personal agent (a stub model speaking the Responses
 * stream) searches, the search's reads run in a worker, and the answer comes
 * back with the message seeded before the server started.
 *
 * Checkpoints: the server hands its database's to a worker, says so once it
 * has, and never falls back to SQLite's own on the server's thread.
 */

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
/** What the search answered, as the model read it. */
let searchOutput: string | null = null;

beforeAll(async () => {
  let step = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      const id = `s${++step}`;
      if (!shown(body).includes("search-case:")) return respond(id, { text: "Noted." });
      const output = ((body.input ?? []) as Array<Record<string, any>>).find((item) => item.type === "function_call_output");
      if (!output) return respond(id, { call: { name: "chat_history_search", args: { query: "rollout notes" } } });
      searchOutput = typeof output.output === "string" ? output.output : JSON.stringify(output.output);
      return respond(id, { text: "Found them." });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port);
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const release = agents.createManagerThread("Release");
        agents.appendMessage({ threadId: release.id, role: "user", source: "user", content: { type: "text", text: "The rollout notes for 2.4 are in the release folder." } });
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

test("The personal agent's chat history search answers from a worker of its own", async () => {
  const agent = (await (await fetch(`${server.baseUrl}/api/agents/personal`)).json() as { agent: { threadId: string } }).agent;
  const sent = await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "search-case: where are the rollout notes?" })
  });
  expect(sent.status).toBe(202);
  const answer = await waitUntil(() => searchOutput, { timeout: 30_000, label: "the search's answer reaching the model" });
  expect(answer).toContain("rollout notes for 2.4");
  expect(fs.readFileSync(server.logFile, "utf8")).not.toContain("[mandate] history-search:");
});

test("the compiled server hands its database's checkpoints to a worker", async () => {
  const log = () => fs.readFileSync(server.logFile, "utf8");
  await waitUntil(() => log().includes("[mandate] checkpoints: run off the main thread every 30s") || null, { timeout: 15_000, label: "the checkpoint worker taking over" });
  expect(log()).not.toContain("background checkpoints stopped");
});
