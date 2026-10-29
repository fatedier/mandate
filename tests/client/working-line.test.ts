import { expect, test } from "bun:test";
import { lineVisible, workingLine, type WorkingInputs } from "../../src/client/routes/window/chat/working-line.js";
import type { AgentMessage } from "../../src/client/store/agent-chat.js";

const START = "2026-09-29T10:00:00.000Z";

function inputs(patch: Partial<WorkingInputs> = {}): WorkingInputs {
  return {
    wakePhase: { wakeId: "w1", phase: "thinking", startedAt: START },
    compressionPhase: null,
    streaming: null,
    messages: [],
    ...patch
  };
}

test("waiting on the model is Working, timed from the wake's start", () => {
  expect(workingLine(inputs())).toEqual({ verb: "Working", since: START });
});

test("while this wake's reply moves the line steps aside; text that has stopped gives it back", () => {
  const T = Date.parse(START) + 10_000;
  const writing = workingLine(inputs({ streaming: { wakeId: "w1", totalText: "I'll run" }, replyMovedAt: T }))!;
  expect([writing.verb, lineVisible(writing, T + 500), lineVisible(writing, T + 1_600)]).toEqual(["Working", false, true]);
  // A stream restored with no fresh text (a reconnect) does not hide the line.
  expect(lineVisible(workingLine(inputs({ streaming: { wakeId: "w1", totalText: "I'll run" } }))!, T)).toBe(true);
  // No text yet, or another wake's stream: nothing to step aside for.
  expect(lineVisible(workingLine(inputs({ streaming: { wakeId: "w1", totalText: "" }, replyMovedAt: T }))!, T)).toBe(true);
  expect(lineVisible(workingLine(inputs({ streaming: { wakeId: "w0", totalText: "old" }, replyMovedAt: T }))!, T)).toBe(true);
});


test("nothing running, nothing shown", () => {
  expect(workingLine(inputs({ wakePhase: { wakeId: "w1", phase: "idle" } }))).toBe(null);
});

test("a running compaction names itself, timed from the wake, else from the compression", () => {
  const compressionPhase = { compressionId: "c1", startedAt: "2026-09-29T10:00:30.000Z" };
  expect(workingLine(inputs({ compressionPhase }))).toEqual({ verb: "Compacting context", since: START });
  expect(workingLine(inputs({ compressionPhase, wakePhase: { wakeId: null, phase: "idle" } })))
    .toEqual({ verb: "Compacting context", since: "2026-09-29T10:00:30.000Z" });
});

test("a wake learned without its start is timed from its messages, else unknown", () => {
  const reply = { id: "m1", wakeId: "w1", wakeStartedAt: "2026-09-29T09:59:00.000Z" } as AgentMessage;
  const other = { id: "m0", wakeId: "w0", wakeStartedAt: "2026-09-29T09:00:00.000Z" } as AgentMessage;
  const wakePhase = { wakeId: "w1", phase: "thinking" as const };
  expect(workingLine(inputs({ wakePhase, messages: [other, reply] }))?.since).toBe("2026-09-29T09:59:00.000Z");
  expect(workingLine(inputs({ wakePhase, messages: [other] }))?.since).toBe(null);
});

test("thinking with a reasoning heading names it; writing and compaction still win", () => {
  const heading = "Checking the changelog format";
  expect(workingLine(inputs({ reasoningHeading: heading }))).toEqual({ verb: heading, since: START });
  const T = Date.parse(START) + 10_000;
  expect(lineVisible(workingLine(inputs({ reasoningHeading: heading, streaming: { wakeId: "w1", totalText: "I'll" }, replyMovedAt: T }))!, T)).toBe(false);
  expect(workingLine(inputs({ reasoningHeading: heading, compressionPhase: { compressionId: "c1", startedAt: START } }))?.verb).toBe("Compacting context");
  expect(workingLine(inputs({ reasoningHeading: null }))?.verb).toBe("Working");
});
