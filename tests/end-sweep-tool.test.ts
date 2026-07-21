import { describe, expect, test } from "bun:test";
import { buildEndSweepTool } from "../src/server/modules/agent/tools/sweep-tools.js";
import { buildSweepToolPacks } from "../src/server/modules/agent/tool-packs.js";

function fakeController() {
  let ended = false;
  return {
    endSweep: () => { ended = true; },
    isEnded: () => ended
  };
}

describe("end_sweep", () => {
  test("ends the sweep and echoes the reason back", async () => {
    const controller = fakeController();
    const tool = buildEndSweepTool(controller);

    const result = await tool.handler(
      { reason: "every feature is done or waiting on the user" },
      {} as never
    );

    expect(controller.isEnded()).toBe(true);
    expect(result).toEqual({
      ended: true,
      reason: "every feature is done or waiting on the user"
    });
  });

  test("does nothing until called", () => {
    // The whole point of the tool: doing nothing and concluding nothing are
    // indistinguishable to the runtime unless the agent says which it was.
    const controller = fakeController();
    buildEndSweepTool(controller);
    expect(controller.isEnded()).toBe(false);
  });

  test("needs no approval — it only quiets a timer", async () => {
    expect(buildEndSweepTool(fakeController()).approval).toBe("never");
  });
});

describe("registration", () => {
  test("is given to manager and to no other scope", () => {
    const controller = fakeController();
    const manager = buildSweepToolPacks({ scope: "manager", sweepController: controller });
    const worker = buildSweepToolPacks({ scope: "worker", sweepController: controller });

    expect(manager.flatMap((p) => p.tools.map((t) => t.name))).toEqual(["end_sweep"]);
    expect(worker).toEqual([]);
  });

  test("registers nothing when no controller is wired", () => {
    // The controller is optional so tests and trimmed runtimes can build scopes
    // without a heartbeat; offering the tool then would hand the agent a
    // control that does nothing.
    expect(buildSweepToolPacks({ scope: "manager" })).toEqual([]);
  });
});
