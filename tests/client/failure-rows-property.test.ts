import { afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import { actionableFailureId } from "../../src/client/routes/window/chat/failure-action.js";
import { useAgentChatStore, type AgentMessage } from "../../src/client/store/agent-chat.js";
import { scopeKey } from "../../src/client/store/agent-chat-utils.js";
import { mockFetch } from "../helpers/fetch.js";

// Whatever the page hears, it ends holding exactly the server's rows, with the
// button where the rule puts it on them. The server writes rows in order. Each
// is heard live or lost to a disconnect, and every disconnect ends in a
// reconnect's catch-up read. Rows heard live may be heard again. The first
// page read and every catch-up read take a snapshot when the server handles
// them and land later, after live rows written since.

afterEach(() => {
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const at = "2026-09-30T09:00:00.000Z";
type Kind = "user" | "reply" | "empty" | "failure" | "context";
function message(seq: number, kind: Kind): AgentMessage {
  const base = { id: `m${seq}`, threadId: "t1", seq, sourceThreadId: null, createdAt: at, wakeId: `w${seq}` };
  switch (kind) {
    case "user": return { ...base, role: "user", source: "user", wakeId: null, content: { type: "text", text: `ask ${seq}` } } as AgentMessage;
    case "reply": return { ...base, role: "assistant", source: "self", content: { type: "assistant", text: `reply ${seq}` } } as AgentMessage;
    case "empty": return { ...base, role: "assistant", source: "self", content: { type: "assistant", text: "" } } as AgentMessage;
    case "context": return { ...base, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context]" } } as AgentMessage;
    case "failure": return { ...base, role: "system", source: "wake-failure", content: { type: "wake_failure", status: "error", message: "boom", stepCount: 1 } } as AgentMessage;
  }
}

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

const row = fc.record({
  kind: fc.constantFrom<Kind>("user", "reply", "empty", "failure", "context"),
  // Heard live, or written while the page was disconnected.
  heard: fc.boolean(),
  // Rows heard again right after this one (indexes into those heard so far).
  again: fc.array(fc.nat(), { maxLength: 2 })
});

test("the page converges on the server's rows and the rule's button", async () => {
  let reached = { lost: 0, stalePage: 0 };
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("manager" as const, "worker" as const),
    fc.array(row, { minLength: 1, maxLength: 10 }),
    // Rows written before the page opened, when the first page is handled,
    // and how many steps each read takes to land.
    fc.nat(), fc.nat(), fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 8 }),
    async (scopeType, rows, beforeSeed, snapshotSeed, delays) => {
      const server = rows.map((r, i) => message(i + 1, r.kind));
      const n = server.length;
      const scope = scopeType === "manager" ? { type: "manager" as const, threadId: "t1" } : { type: "worker" as const, featureId: "f1" };
      useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });

      // Time moves one row at a time; a read waits for its step.
      let written = beforeSeed % (n + 1);
      const snapshotAt = written + snapshotSeed % (n - written + 1);
      let waiters: Array<{ until: number; resolve: () => void }> = [];
      const until = (step: number) => new Promise<void>((resolve) => {
        if (written >= step) resolve(); else waiters.push({ until: step, resolve });
      });
      const advance = (to: number) => {
        written = to;
        const due = waiters.filter((w) => w.until <= written);
        waiters = waiters.filter((w) => w.until > written);
        for (const w of due) w.resolve();
      };
      let reads = 0;
      mockFetch(async (call) => {
        const since = new URL(call.url, "http://x").searchParams.get("since");
        const delay = delays[reads++ % delays.length]!;
        if (since === null) {
          await until(snapshotAt);
          const snapshot = server.slice(0, written);
          if (snapshot.length < n) reached.stalePage++;
          await until(written + delay);
          return Response.json({ thread: { id: "t1" }, messages: snapshot, hasMore: false, activeWake: null, readAt: at });
        }
        const snapshot = server.slice(0, written).filter((m) => m.seq > Number(since));
        await until(written + delay);
        return Response.json({ thread: { id: "t1" }, messages: snapshot, activeWake: null, readAt: at });
      });

      const firstLoad = useAgentChatStore.getState().ensureThreadLoaded(scope);
      await settle();
      const heard: AgentMessage[] = [];
      let disconnected = false;
      for (let i = written; i < n; i++) {
        advance(i + 1);
        await settle();
        const r = rows[i]!;
        if (!r.heard) { disconnected = true; reached.lost++; continue; }
        if (disconnected) {
          disconnected = false;
          void useAgentChatStore.getState().refetchIncrementalForOpenScopes();
          await settle();
        }
        const store = useAgentChatStore.getState();
        store.onMessageAppended("t1", server[i]!);
        heard.push(server[i]!);
        for (const k of r.again) store.onMessageAppended("t1", heard[k % heard.length]!);
        await settle();
      }
      if (disconnected) void useAgentChatStore.getState().refetchIncrementalForOpenScopes();
      advance(Number.POSITIVE_INFINITY);
      await firstLoad;
      await settle();

      const held = useAgentChatStore.getState().threadsByScope.get(scopeKey(scope))!.messages;
      expect(held.map((m) => m.id)).toEqual(server.map((m) => m.id));
      expect(actionableFailureId(held, false, true)).toBe(actionableFailureId(server, false, true));
      // And the rule on the server's rows: the last row, when a failure.
      const last = server.at(-1)!;
      expect(actionableFailureId(server, false, true)).toBe(last.content.type === "wake_failure" ? last.id : null);
    }
  ), { numRuns: 150 });
  // The generator reaches what it claims: rows lost to a disconnect, and a
  // first page older than the thread.
  expect(reached.lost).toBeGreaterThan(0);
  expect(reached.stalePage).toBeGreaterThan(0);
}, 120_000);
