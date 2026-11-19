import { expect, test } from "bun:test";
import * as path from "node:path";
import { e2eProjectName, runE2eInDocker } from "../scripts/test-e2e.js";

/** `bun run test:e2e` gives each run a Compose project of its own: with the
 *  default name every checkout built and ran the same image tag, so a run
 *  started in one worktree could test another worktree's build. */

const CHECKOUT = "/work/mandate";
const COMPOSE = path.join(CHECKOUT, "e2e", "docker-compose.yml");

function recorder(codes: { run: number; down: number }) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (command: string[]) => {
      calls.push(command);
      return command.includes("down") ? codes.down : codes.run;
    }
  };
}

test("a run uses a Compose project of its own and removes it afterwards", async () => {
  const fake = recorder({ run: 0, down: 0 });
  const code = await runE2eInDocker(["e2e/server.test.ts", "--bail=1"], { checkoutDir: CHECKOUT, runId: "a1b2c3", run: fake.run });
  const project = e2eProjectName(CHECKOUT, "a1b2c3");
  expect(code).toBe(0);
  expect(fake.calls).toEqual([
    ["docker", "compose", "-p", project, "-f", COMPOSE, "run", "--rm", "--build", "tests", "bun", "e2e/run.ts", "e2e/server.test.ts", "--bail=1"],
    ["docker", "compose", "-p", project, "-f", COMPOSE, "down", "--rmi", "local", "--remove-orphans"]
  ]);
});

test("a failed run is still cleaned up, and its exit code is the result", async () => {
  const fake = recorder({ run: 3, down: 0 });
  expect(await runE2eInDocker([], { checkoutDir: CHECKOUT, runId: "a1b2c3", run: fake.run })).toBe(3);
  expect(fake.calls.map((call) => call.includes("down"))).toEqual([false, true]);
});

test("a cleanup that fails does not hide the run's result", async () => {
  const fake = recorder({ run: 0, down: 1 });
  expect(await runE2eInDocker([], { checkoutDir: CHECKOUT, runId: "a1b2c3", run: fake.run })).toBe(0);
});

test("two checkouts, or two runs in one, never share a project, and every name is one Compose accepts", () => {
  const names = [
    e2eProjectName("/work/mandate", "a1b2c3"),
    e2eProjectName("/work/mandate/.claude/worktrees/worker", "a1b2c3"),
    e2eProjectName("/work/mandate", "d4e5f6")
  ];
  expect(new Set(names).size).toBe(3);
  for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  // The same checkout named two ways is one checkout.
  expect(e2eProjectName("/work/mandate/", "a1b2c3")).toBe(names[0]!);
});
