import { expect, test } from "bun:test";
import { mailboxWakeReason, startupMailboxWakeReason } from "../src/server/runtime/mailbox-wake-reason.js";

// A notice that could not wake a busy or held conversation waits in its
// mailbox; the wake that later starts for it must still read as a notice.
test("a wake started for queued mail says what kind it is only when all of it is one kind", () => {
  expect(mailboxWakeReason(["worker-report", "worker-report"])).toBe("worker-report");
  expect(mailboxWakeReason(["thread-notice"])).toBe("thread-notice");
  expect(mailboxWakeReason(["thread-notice", "thread-notice"])).toBe("thread-notice");
  expect(mailboxWakeReason(["thread-notice", "worker-report"])).toBe("user");
  expect(mailboxWakeReason(["manager"])).toBe("user");
  expect(mailboxWakeReason(["subagent-result"])).toBe("subagent-result");
  expect(mailboxWakeReason(["subagent-result", "subagent-result"])).toBe("subagent-result");
  // A page subagent's note that wakes Your agent is a subagent's result too.
  expect(mailboxWakeReason(["page-result"])).toBe("subagent-result");
  expect(mailboxWakeReason(["page-result", "subagent-result"])).toBe("subagent-result");
  expect(mailboxWakeReason(["subagent-result", "worker-report"])).toBe("user");
});

// At start-up every thread with queued mail was always woken as if a person
// had written. A notice that waited through a restart keeps its own reason.
test("at start-up a mailbox holding only notices is woken as for a notice; anything else as before", () => {
  expect(startupMailboxWakeReason(["thread-notice"])).toBe("thread-notice");
  expect(startupMailboxWakeReason(["thread-notice", "thread-notice"])).toBe("thread-notice");
  expect(startupMailboxWakeReason(["worker-report"])).toBe("user");
  // A result that waited through a restart is read by the startup wake, as a report is.
  expect(startupMailboxWakeReason(["subagent-result"])).toBe("user");
  expect(startupMailboxWakeReason(["restart-recovery", "thread-notice"])).toBe("user");
});


// A background command's end wakes its conversation as a subagent's result does.
test("only command results wake for a command result; with a subagent's result, for the results", () => {
  expect(mailboxWakeReason(["command-result"])).toBe("command-result");
  expect(mailboxWakeReason(["command-result", "command-result"])).toBe("command-result");
  expect(mailboxWakeReason(["command-result", "subagent-result"])).toBe("subagent-result");
  expect(mailboxWakeReason(["command-result", "user"])).toBe("user");
  expect(startupMailboxWakeReason(["command-result"])).toBe("user");
});
