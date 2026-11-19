import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { assertStubProvider, respond, seedStubProvider, shown } from "./helpers/responses-stub.js";

/**
 * The window a conversation keeps in memory, through the compiled server:
 * The personal agent's turn takes two steps (a tool call, then an answer), and the
 * second step's request is the first's with the call and its result after
 * it. Then Settings › Storage "Clean up now" shortens a long tool result
 * already in the window, and the next turn's request carries it shortened —
 * the held window learned of the change without being told.
 */

const SEEDED_CALL = "call_seeded";
const LONG_RESULT = `window-check: ${"x".repeat(6000)}`;

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
/** The input of each request the turns sent, in order. */
const one: Array<Array<Record<string, any>>> = [];
const two: Array<Array<Record<string, any>>> = [];

/** The seeded tool result as a request carried it. */
function seededOutput(input: Array<Record<string, any>>): string {
  const item = input.find((entry) => entry.type === "function_call_output" && entry.call_id === SEEDED_CALL);
  if (!item) throw new Error("the request has no seeded tool result");
  return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
}

beforeAll(async () => {
  let step = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      const input = (body.input ?? []) as Array<Record<string, any>>;
      const id = `s${++step}`;
      const text = shown(body);
      if (text.includes("window-case: two")) {
        two.push(input);
        return respond(id, { text: "Second turn done." });
      }
      if (!text.includes("window-case: one")) return respond(id, { text: "Noted." });
      one.push(input);
      const answered = input.some((entry) => entry.type === "function_call_output" && /^call_s\d+$/.test(String(entry.call_id)));
      return answered ? respond(id, { text: "First turn done." }) : respond(id, { call: { name: "chat_history_search", args: { query: "rollout notes" } } });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port);
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const thread = agents.getOrCreatePersonalThread();
        agents.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Check the build output." } });
        agents.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: SEEDED_CALL, toolName: "chat_history_search", args: { query: "build output" } }] } });
        agents.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: SEEDED_CALL, toolName: "chat_history_search", result: LONG_RESULT } });
        agents.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The output is long; nothing failed." } });
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

async function send(threadId: string, content: string): Promise<void> {
  const sent = await fetch(`${server.baseUrl}/api/agents/threads/${threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content })
  });
  expect(sent.status).toBe(202);
}

test("The personal agent's window, held between steps, follows a cleanup that shortens a tool result", async () => {
  const agent = (await (await fetch(`${server.baseUrl}/api/agents/personal`)).json() as { agent: { threadId: string } }).agent;

  await send(agent.threadId, "window-case: one");
  await waitUntil(() => one.length >= 2 || null, { timeout: 30_000, label: "the first turn's two steps" });
  const [first, second] = one as [Array<Record<string, any>>, Array<Record<string, any>>];
  // The second step sends the first step's history, then its own call and result.
  expect(second.slice(0, first.length)).toEqual(first);
  expect(second.slice(first.length).map((entry) => entry.type)).toContain("function_call_output");
  expect(seededOutput(first)).toContain(LONG_RESULT);

  const cleaned = await fetch(`${server.baseUrl}/api/storage/cleanup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const result = await cleaned.json() as { ok: boolean; truncated: number };
  expect(result.ok).toBe(true);
  expect(result.truncated).toBeGreaterThanOrEqual(1);

  await send(agent.threadId, "window-case: two");
  const next = await waitUntil(() => two[0] ?? null, { timeout: 30_000, label: "the second turn's request" });
  const shortened = seededOutput(next);
  expect(shortened).toContain("window-check: ");
  expect(shortened.length).toBeLessThan(LONG_RESULT.length);
}, 90_000);
