import { expect, test } from "bun:test";
import { CompressionSummaryMessage } from "../../src/client/routes/window/chat/CompressionSummaryMessage.js";
import type { AgentMessage } from "../../src/client/store/agent-chat.js";
import { mount } from "../helpers/mount.js";

// Idle compaction: its boundary says why it ran; any other compaction's is
// unchanged.

const summary = (extra: Record<string, unknown>): AgentMessage => ({
  id: "m1", threadId: "t1", seq: 5, role: "user", source: "compression", createdAt: "2026-10-29T10:00:00.000Z",
  content: { type: "summary", summary: "The notes are drafted.", replacedRange: [1, 42], replacedCount: 42, compactedCount: 42, tokensBefore: 312_000, retained: [], ...extra }
} as unknown as AgentMessage);

test("an idle compaction's boundary says it ran after the thread sat idle", () => {
  const { host } = mount(<CompressionSummaryMessage message={summary({ trigger: "idle", idleMinutes: 55 })} />);
  expect(host.textContent).toBe("Compacted 42 earlier messages at 312.0k tokens after 55 min idle · View summary");
});

test("the reason comes from the idle tag alone", () => {
  const { host } = mount(<CompressionSummaryMessage message={summary({ idleMinutes: 55 })} />);
  expect(host.textContent).toBe("Compacted 42 earlier messages at 312.0k tokens · View summary");
});

test("any other compaction's boundary is as before", () => {
  const { host } = mount(<CompressionSummaryMessage message={summary({})} />);
  expect(host.textContent).toBe("Compacted 42 earlier messages at 312.0k tokens · View summary");
});
