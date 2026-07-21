import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const PROMPT = fs.readFileSync(
  path.join(import.meta.dir, "..", "src/server/modules/agent/prompts/worker.md"),
  "utf8"
);

test("the immediate-inspection rule is scoped to after the wake", () => {
  // Without the qualifier this reads as "watch_window then read_pane", which is
  // the pairing that produced an agent polling a pane it was already watching.
  const line = PROMPT.split("\n").find((l) => l.includes("act on it immediately"));
  expect(line).toBeDefined();
  expect(line!.toLowerCase()).toContain("after");
});

test("registering a watch is named as a valid way to stop", () => {
  // The anti-stalling rule otherwise pushes toward action in exactly the
  // situation where doing nothing is correct.
  expect(PROMPT).toContain("Registering a watch is an action");
});
