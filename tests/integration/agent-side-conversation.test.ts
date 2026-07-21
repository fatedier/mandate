import { expect, test } from "bun:test";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { MandateStore } from "../../src/server/app/store.js";
import {
  buildAgentsTestApp,
  buildTestScopes,
  deleteJson,
  getJson,
  postJson
} from "../helpers/test-app.js";
import { freshAgentEnv } from "../helpers/fixtures.js";

function buildApp(agentStore: AgentStore, store: MandateStore) {
  const wakes: Array<{ threadId: string; reason: string; messageId: string | null }> = [];
  return {
    wakes,
    app: buildAgentsTestApp({
      agentStore,
      wakeScheduler: {
        wake: (threadId, reason, messageId) => {
          wakes.push({ threadId, reason, messageId });
          return `wake-${wakes.length}`;
        },
        isThreadBusy: () => false,
        getRunningWakeForThread: () => null
      },
      scopes: buildTestScopes(new FeaturesStore(store.db))
    })
  };
}

test("side conversation HTTP flow keeps transcripts isolated and explicitly transfers a summary", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-side-flow-");
  try {
    const { app, wakes } = buildApp(agentStore, store);
    const mainMessage = await postJson(app, "/api/agents/manager/messages", {
      content: "Investigate the current task"
    });
    const parentThreadId = mainMessage.body.threadId as string;

    const fork = await postJson(app, `/api/agents/threads/${parentThreadId}/forks`, {});
    expect(fork.status).toBe(200);
    expect(fork.body.thread.kind).toBe("side");
    expect(fork.body.thread.parentThreadId).toBe(parentThreadId);
    const sideThreadId = fork.body.thread.id as string;

    const sideMessage = await postJson(app, `/api/agents/threads/${sideThreadId}/messages`, {
      content: "Check one additional detail",
      clientRequestId: "side-message-1"
    });
    expect(sideMessage.status).toBe(202);
    expect(sideMessage.body.threadId).toBe(sideThreadId);
    expect(agentStore.getMessages(parentThreadId).map((message) => message.content)).not.toContainEqual(
      { type: "text", text: "Check one additional detail", clientRequestId: "side-message-1" }
    );

    agentStore.appendMessage({
      threadId: sideThreadId,
      role: "assistant",
      source: "self",
      content: { type: "assistant", text: "The additional detail is useful." }
    });
    const draft = await postJson(app, `/api/agents/threads/${sideThreadId}/summary-draft`, {});
    expect(draft.body.content).toBe("The additional detail is useful.");

    const transfer = await postJson(app, `/api/agents/threads/${sideThreadId}/transfers`, {
      content: "Side finding: the additional detail is useful.",
      clientRequestId: "transfer-1"
    });
    expect(transfer.status).toBe(202);
    expect(transfer.body.transfer.status).toBe("delivered");
    expect(wakes.at(-1)?.reason).toBe("side-summary");
    const parentMessages = agentStore.getMessages(parentThreadId);
    expect(parentMessages.at(-1)?.source).toBe("side-summary");
    expect(parentMessages.at(-1)?.sourceThreadId).toBe(sideThreadId);

    const sidePage = await getJson(app, `/api/agents/threads/${sideThreadId}`);
    expect(sidePage.status).toBe(200);
    expect(sidePage.body.messages.length).toBe(2);

    const closed = await deleteJson(app, `/api/agents/threads/${sideThreadId}`);
    expect(closed.status).toBe(200);
    expect(closed.body.thread.closedAt).toBeTruthy();
    expect((await getJson(app, `/api/agents/threads/${sideThreadId}`)).status).toBe(404);
  } finally {
    cleanup();
  }
});
