import { expect, test } from "bun:test";
import { applyLoggingConfig } from "../src/server/app/logging-config.js";
import { llmStreamTrace, setLlmStreamTrace } from "../src/server/modules/agent/llm-stream-diagnostics.js";
import { getLogLevel, logStacks, setLogLevel, setLogStacks } from "../src/server/platform/logger.js";

// config.json's logging section, applied at start and on every reload: the
// three settings go together, so a reload that changes one is never missed.
test("applying the logging section sets the level, stacks and stream trace", () => {
  const before = { level: getLogLevel(), stacks: logStacks(), streamTrace: llmStreamTrace() };
  try {
    applyLoggingConfig({ level: "warn", stacks: true, streamTrace: false });
    expect({ level: getLogLevel(), stacks: logStacks(), streamTrace: llmStreamTrace() }).toEqual({ level: "warn", stacks: true, streamTrace: false });
    applyLoggingConfig({ level: "debug", stacks: false, streamTrace: true });
    expect({ level: getLogLevel(), stacks: logStacks(), streamTrace: llmStreamTrace() }).toEqual({ level: "debug", stacks: false, streamTrace: true });
  } finally {
    setLogLevel(before.level);
    setLogStacks(before.stacks);
    setLlmStreamTrace(before.streamTrace);
  }
});
