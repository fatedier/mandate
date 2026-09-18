import { expect, test } from "bun:test";
import {
  cancelWake,
  closeSideThread,
  createSideThread,
  deleteQueuedMessage,
  deleteThreadQueuedMessage,
  fetchSideSummaryDraft,
  fetchThreadById,
  fetchThreadPage,
  postMessage,
  postThreadMessage,
  retargetSideSummary,
  transferSideSummary
} from "@/store/agent-chat-api";

async function withResponse(response: () => Response, run: () => Promise<void>) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
  try { await run(); } finally { globalThis.fetch = previousFetch; }
}

const manager = { type: "manager" } as const;
const calls = [
  { name: "fetchThreadPage", run: () => fetchThreadPage(manager) },
  { name: "fetchThreadById", run: () => fetchThreadById("side") },
  { name: "postMessage", run: () => postMessage(manager, "Hello", [], "request") },
  { name: "postThreadMessage", run: () => postThreadMessage("side", "Hello", [], "request") },
  { name: "deleteQueuedMessage", run: () => deleteQueuedMessage(manager, "request") },
  { name: "cancelWake", run: () => cancelWake("wake") },
  { name: "createSideThread", run: () => createSideThread("main") },
  { name: "closeSideThread", run: () => closeSideThread("side") },
  { name: "deleteThreadQueuedMessage", run: () => deleteThreadQueuedMessage("side", "request") },
  { name: "fetchSideSummaryDraft", run: () => fetchSideSummaryDraft("side") },
  { name: "transferSideSummary", run: () => transferSideSummary("side", "Summary", "request") },
  { name: "retargetSideSummary", run: () => retargetSideSummary("transfer", "main") }
];

test.each(calls)("chat API $name shares HTTP, business, and non-JSON error handling", async ({ run }) => {
  for (const status of [200, 409]) {
    await withResponse(() => Response.json({ error: "Conversation unavailable" }, { status }), async () => {
      await expect(run()).rejects.toThrow("Conversation unavailable");
    });
  }
  await withResponse(() => Response.json({ ok: false, error: "Request rejected" }), async () => {
    await expect(run()).rejects.toThrow("Request rejected");
  });
  await withResponse(() => new Response("<html>Proxy failure</html>", { status: 502 }), async () => {
    await expect(run()).rejects.toThrow("HTTP 502");
  });
});

test("thread reads preserve pagination, ordering, and context usage", async () => {
  const contextUsage = { inputTokens: 8000, budgetTokens: 200000, updatedAt: null, source: "compression_budget" };
  await withResponse(() => Response.json({
    thread: { id: "thread" }, messages: [3, 1, 2].map(seq => ({ id: String(seq), seq })), hasMore: true, contextUsage
  }), async () => {
    const main = await fetchThreadPage(manager, 3);
    expect(main.messages.map(message => message.seq)).toEqual([1, 2]);
    expect(main).toMatchObject({ thread: { id: "thread" }, hasMore: true, contextUsage });
    const side = await fetchThreadById("side", 4, 0);
    expect(side.messages.map(message => message.seq)).toEqual([1, 2, 3]);
    expect(side).toMatchObject({ thread: { id: "thread" }, hasMore: true, contextUsage });
  });
});

test("void chat actions accept JSON and no-content success responses", async () => {
  for (const response of [() => Response.json({ ok: true }), () => new Response(null, { status: 204 })]) {
    await withResponse(response, async () => {
      await closeSideThread("side");
      await deleteThreadQueuedMessage("side", "request");
    });
  }
});

test("summary transfer actions still validate the required transfer", async () => {
  await withResponse(() => Response.json({ ok: true }), async () => {
    await expect(transferSideSummary("side", "Summary", "request")).rejects.toThrow("missing transfer");
    await expect(retargetSideSummary("transfer", "main")).rejects.toThrow("missing transfer");
  });
  const payload = { transfer: { id: "transfer", status: "pending" }, wakeId: "wake" };
  await withResponse(() => Response.json(payload), async () => {
    expect(await transferSideSummary("side", "Summary", "request") as unknown).toEqual(payload);
    expect(await retargetSideSummary("transfer", "main") as unknown).toEqual(payload);
  });
});
