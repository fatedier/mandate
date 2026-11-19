/**
 * Appends messages to one thread from a connection of its own, as a second
 * writer would: `{ dir, threadId, count }` in, `{ done, error? }` out.
 * The two workers of a test are started together and race.
 */
import { MandateStore } from "../../src/server/app/store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ dir: string; threadId: string; count: number; tag: string }>) => {
  const { dir, threadId, count, tag } = event.data;
  // Opened inside the try: a store that cannot open says why, at once.
  let store: MandateStore | null = null;
  try {
    store = new MandateStore(dir);
    const agent = new AgentStore(store.db);
    for (let i = 0; i < count; i++) {
      agent.appendMessage({ threadId, role: "tool", source: "self", content: { type: "tool_result", toolCallId: `${tag}-${i}`, toolName: "bash", result: "ok" } });
    }
    self.postMessage({ done: true });
  } catch (error) {
    self.postMessage({ done: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  } finally {
    store?.db.close();
  }
};
