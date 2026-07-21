import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { z } from "zod";
import { ToolRegistry, ToolDispatcher } from "../src/server/modules/agent/tool-registry.js";
import { withTempDataDir } from "./helpers/fixtures.js";

test("ToolRegistry.register: stores tool definitions; AI SDK tools shape correct", () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "echo", description: "Echo input",
    parameters: z.object({ text: z.string() }),
    approval: "never",
    handler: async ({ text }) => ({ echoed: text })
  });
  expect(reg.tools.echo).toBeTruthy();
  // execute is intentionally NOT defined: our wake-loop dispatches tools manually
  // to avoid double-execution (AI SDK would also call execute automatically).
  expect(typeof reg.tools.echo.execute).toBe("undefined");
  expect(reg.tools.echo.description).toBe("Echo input");
});

test("ToolDispatcher: dispatches successful tool call", async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "add", description: "Add",
    parameters: z.object({ a: z.number(), b: z.number() }),
    approval: "never",
    handler: async ({ a, b }) => ({ sum: a + b })
  });
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "add", args: { a: 2, b: 3 } },
    { threadId: "t", wakeId: "w" }
  );
  expect(r).toEqual({ result: { sum: 5 } });
});

test("ToolDispatcher: catches handler error, returns isError result", async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "fail", description: "Always fails",
    parameters: z.object({}),
    approval: "never",
    handler: async () => { throw new Error("boom"); }
  });
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "fail", args: {} },
    { threadId: "t", wakeId: "w" }
  );
  expect(r.isError).toBe(true);
  expect(r.error!).toMatch(/boom/);
});

test("ToolDispatcher: rejects unknown tool name", async () => {
  const reg = new ToolRegistry();
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "ghost", args: {} },
    { threadId: "t", wakeId: "w" }
  );
  expect(r.isError).toBe(true);
  expect(r.error!).toMatch(/unknown tool/i);
});

test("ToolDispatcher: validates args against zod schema", async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: "needsString", description: "Needs string",
    parameters: z.object({ s: z.string() }),
    approval: "never",
    handler: async ({ s }) => ({ ok: s })
  });
  const dispatcher = new ToolDispatcher(reg);
  const r = await dispatcher.dispatch(
    { toolCallId: "c1", toolName: "needsString", args: { s: 123 } },
    { threadId: "t", wakeId: "w" }
  );
  expect(r.isError).toBe(true);
  expect(r.error!).toMatch(/validation|expected string/i);
});

test("ToolDispatcher: persists large text results under Mandate data dir", async () => {
  const { dataDir, restore } = withTempDataDir();
  const reg = new ToolRegistry();
  const large = "x".repeat(70 * 1024);
  reg.register({
    name: "largeText",
    description: "Large text",
    parameters: z.object({}),
    approval: "never",
    handler: async () => large
  });

  try {
    const dispatcher = new ToolDispatcher(reg);
    const r = await dispatcher.dispatch(
      { toolCallId: "call/1", toolName: "largeText", args: {} },
      { threadId: "thread/1", wakeId: "wake/1" } as any
    );
    const text = r.result as string;
    expect(text).toContain("<persisted-output>");
    expect(text).toContain("Use read with this path");

    const outputPath = text.split("\n").find((line) => line.startsWith(dataDir));
    expect(outputPath).toBeTruthy();
    expect(outputPath).toContain("resources/global/tool-output/thread_1/");
    expect(fs.readFileSync(outputPath!, "utf8")).toBe(large);
  } finally {
    restore();
  }
});

test("ToolDispatcher: persists project tool output under project resources", async () => {
  const { dataDir, restore } = withTempDataDir();
  const reg = new ToolRegistry();
  const large = "y".repeat(70 * 1024);
  reg.register({
    name: "largeText",
    description: "Large text",
    parameters: z.object({}),
    approval: "never",
    handler: async () => large
  });

  try {
    const dispatcher = new ToolDispatcher(reg);
    const r = await dispatcher.dispatch(
      { toolCallId: "call-1", toolName: "largeText", args: {} },
      {
        threadId: "thread-1",
        wakeId: "wake-1",
        project: { id: "proj-1" }
      } as any
    );
    const text = r.result as string;
    const outputPath = text.split("\n").find((line) => line.startsWith(dataDir));
    expect(outputPath).toContain("resources/projects/proj-1/tool-output/thread-1/");
    expect(fs.readFileSync(outputPath!, "utf8")).toBe(large);
  } finally {
    restore();
  }
});
