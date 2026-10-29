// Type-level checks for tests/helpers/typed.ts. Not a test file (bun runs
// *.test.ts only); `bun run typecheck:tests` checks it, and every
// expect-error directive below must stay an error. (An explicit undefined
// for a required member is refused at run time: see tests/test-harness.)
import { agentMessage, stub, toolContext } from "./typed.js";

// @ts-expect-error -- not a member of ToolContext.
toolContext({ threadID: "thr_a" });
// @ts-expect-error -- a misspelt member inside the scope, caught as in a hand-written object.
toolContext({ scope: { kind: "manager", managerDir: "", projectWorkingDirs: [], managerDri: "" } });
toolContext({ wakeId: "w1" });

// @ts-expect-error -- content is the test's own, always.
agentMessage({ seq: 2 });
// @ts-expect-error -- a misspelt member inside the content, caught as in a hand-written object.
agentMessage({ content: { type: "assistant", text: "x", endTrun: false } });
agentMessage({ content: { type: "text", text: "x" }, wakeReason: undefined });

interface Store { list(): string[]; count(): number }
// @ts-expect-error -- not a member of the stubbed type.
stub<Store>({ lst: () => [] });
// @ts-expect-error -- the wrong signature for a member.
stub<Store>({ list: () => 3 });
stub<Store>({ list: () => [] });
