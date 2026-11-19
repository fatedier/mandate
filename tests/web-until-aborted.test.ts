import { expect, test } from "bun:test";
import { untilAborted } from "../src/server/modules/web/until-aborted.js";

test("work already given up on is still watched, so its failure is never left unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    const work = Promise.reject(new Error("the body broke"));
    await expect(untilAborted(work, stop.signal)).rejects.toThrow("stopped");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toStrictEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("work that ends first gives its value or its error", async () => {
  const signal = new AbortController().signal;
  expect(await untilAborted(Promise.resolve(3), signal)).toBe(3);
  await expect(untilAborted(Promise.reject(new Error("no")), signal)).rejects.toThrow("no");
});
