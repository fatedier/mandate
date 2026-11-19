import { expect, test } from "bun:test";
import { createKeyedExclusion } from "../src/server/platform/process/keyed-exclusion.js";

// What checks tmux or git and then changes it runs alone for its resource (a
// project, a pane, a window): two requests no longer interleave between the
// check and the change now that the commands run while the server goes on.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function held() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

test("work for one key runs one at a time, in the order it came", async () => {
  const exclusion = createKeyedExclusion();
  const order: string[] = [];
  const first = held();
  const a = exclusion.run("proj_1", async () => { order.push("a starts"); await first.gate; order.push("a ends"); return "a"; });
  const b = exclusion.run("proj_1", async () => { order.push("b starts"); return "b"; });
  await tick();
  expect(order).toEqual(["a starts"]);
  first.release();
  expect(await Promise.all([a, b])).toEqual(["a", "b"]);
  expect(order).toEqual(["a starts", "a ends", "b starts"]);
});

test("work for different keys runs side by side", async () => {
  const exclusion = createKeyedExclusion();
  const first = held();
  const order: string[] = [];
  const a = exclusion.run("proj_1", async () => { await first.gate; order.push("a"); });
  const b = exclusion.run("proj_2", async () => { order.push("b"); });
  await b;
  expect(order).toEqual(["b"]);
  first.release();
  await a;
});

test("work that throws gives its key up and its caller the error", async () => {
  const exclusion = createKeyedExclusion();
  const failed = exclusion.run("pane_1", () => { throw new Error("tmux did not answer"); });
  await expect(failed).rejects.toThrow("tmux did not answer");
  expect(await exclusion.run("pane_1", () => "next")).toBe("next");
});

test("a key nobody holds or waits for is forgotten", async () => {
  const exclusion = createKeyedExclusion();
  const first = held();
  const a = exclusion.run("win_1", () => first.gate);
  const b = exclusion.run("win_1", () => undefined);
  expect(exclusion.size()).toBe(1);
  first.release();
  await Promise.all([a, b]);
  expect(exclusion.size()).toBe(0);
});
