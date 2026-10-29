import { expect, test } from "bun:test";
import {
  cancelWake,
  deleteQueuedMessage,
  deleteThreadQueuedMessage,
  fetchThreadById,
  fetchThreadPage,
  postMessage,
  postThreadMessage
} from "@/store/agent-chat-api";
import { withFetch } from "../helpers/fetch.js";

const worker = { type: "worker", featureId: "f1" } as const;
const calls = [
  { name: "fetchThreadPage", run: () => fetchThreadPage(worker) },
  { name: "fetchThreadById", run: () => fetchThreadById("thread") },
  { name: "postMessage", run: () => postMessage(worker, "Hello", [], "request") },
  { name: "postThreadMessage", run: () => postThreadMessage("thread", "Hello", [], "request") },
  { name: "deleteQueuedMessage", run: () => deleteQueuedMessage(worker, "request") },
  { name: "cancelWake", run: () => cancelWake("wake") },
  { name: "deleteThreadQueuedMessage", run: () => deleteThreadQueuedMessage("thread", "request") }
];

// Each goes through readJson, whose error shapes api-json.test.ts covers: one
// case per function proves the wiring.
test.each(calls)("chat API $name reads its errors through readJson", async ({ run }) => {
  await withFetch(() => Response.json({ error: "Conversation unavailable" }), async () => {
    await expect(run()).rejects.toThrow("Conversation unavailable");
  });
});

test("thread reads preserve pagination, ordering, and context usage", async () => {
  const contextUsage = { inputTokens: 8000, budgetTokens: 200000, updatedAt: null, source: "compression_budget" };
  await withFetch(() => Response.json({
    thread: { id: "thread" }, messages: [3, 1, 2].map(seq => ({ id: String(seq), seq })), hasMore: true, contextUsage
  }), async () => {
    const main = await fetchThreadPage(worker, 3);
    expect(main.messages.map(message => message.seq)).toEqual([1, 2]);
    expect(main).toMatchObject({ thread: { id: "thread" }, hasMore: true, contextUsage });
    const byId = await fetchThreadById("thread", 4, 0);
    expect(byId.messages.map(message => message.seq)).toEqual([1, 2, 3]);
    expect(byId).toMatchObject({ thread: { id: "thread" }, hasMore: true, contextUsage });
  });
});

test("void chat actions accept JSON and no-content success responses", async () => {
  for (const response of [() => Response.json({ ok: true }), () => new Response(null, { status: 204 })]) {
    await withFetch(response, async () => {
      await deleteThreadQueuedMessage("thread", "request");
    });
  }
});
