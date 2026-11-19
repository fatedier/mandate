import { expect, test } from "bun:test";
import { commandMatches, commandOfDraft, conversationState } from "../../src/client/routes/window/chat/command-draft.js";
import type { AgentCommandDto } from "../../src/shared/api/agents.js";

const COMMANDS: AgentCommandDto[] = [
  { name: "/compact", description: "Summarize earlier messages to free up context", blocked: { running: "A turn is running", compacting: "Already compacting" } },
  { name: "/stop", description: "Stop the running turn", blocked: { idle: "Nothing is running", compacting: "A compaction can't be stopped" } },
  { name: "/context", description: "Show how much context is in use", blocked: {} }
];
const names = (draft: string) => commandMatches(draft, COMMANDS).map((c) => c.name);

test("the list holds the commands a draft could still become, and only while the draft is a slash and one word", () => {
  expect(names("/")).toEqual(["/compact", "/stop", "/context"]);
  expect(names("/c")).toEqual(["/compact", "/context"]);
  expect(names("/com")).toEqual(["/compact"]);
  expect(names("/compact")).toEqual(["/compact"]);
  expect(names("/s")).toEqual(["/stop"]);
  // A path, a finished command with text after it, a slash further in: no list.
  expect(["/x", "/tmp/foo", "/compact ", "/compact now", "say /c", " /c", "", "c"].map(names)).toEqual([[], [], [], [], [], [], [], []]);
});

test("a draft names a command only by its first word, exactly", () => {
  const named = (draft: string) => commandOfDraft(draft, COMMANDS)?.name ?? null;
  expect(["/compact", "  /compact  ", "/compact now", "/stop\n"].map(named)).toEqual(["/compact", "/compact", "/compact", "/stop"]);
  expect(["/tmp/foo is broken", "/compactfoo", "/c", "/", "compact", ""].map(named)).toEqual([null, null, null, null, null, null]);
});

test("a conversation is running with a wake in flight, compacting with a compaction and no wake, else idle", () => {
  const idle = { wakeId: null, phase: "idle" as const };
  const thinking = { wakeId: "w1", phase: "thinking" as const, startedAt: "2026-10-11T00:00:00.000Z" };
  const compaction = { compressionId: "c1", startedAt: "2026-10-11T00:00:00.000Z" };
  expect(conversationState({ wakePhase: idle, compressionPhase: null })).toBe("idle");
  expect(conversationState({ wakePhase: thinking, compressionPhase: null })).toBe("running");
  // A turn that is compacting at its gate is a turn: Stop works, /compact waits.
  expect(conversationState({ wakePhase: thinking, compressionPhase: compaction })).toBe("running");
  expect(conversationState({ wakePhase: idle, compressionPhase: compaction })).toBe("compacting");
  expect(conversationState(null)).toBe("idle");
});
