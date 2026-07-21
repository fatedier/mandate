import { expect, test } from "bun:test";
import { buildUiOpenUrlTool } from "../src/server/modules/ui-context/tools/ui-open-url.js";

test("buildUiOpenUrlTool: emits open-url for https URL", async () => {
  const calls: any[] = [];
  const tool = buildUiOpenUrlTool((action, payload) => calls.push({ action, payload }));
  const r = await tool.handler({ url: "https://example.com" }, {} as any);
  expect(r).toEqual({ ok: true });
  expect(calls.length).toBe(1);
  expect(calls[0].action).toBe("open-url");
  expect(calls[0].payload.url).toBe("https://example.com");
});

test("buildUiOpenUrlTool: emits open-url for http URL", async () => {
  const calls: any[] = [];
  const tool = buildUiOpenUrlTool((action, payload) => calls.push({ action, payload }));
  await tool.handler({ url: "http://localhost:3000" }, {} as any);
  expect(calls.length).toBe(1);
});

test("buildUiOpenUrlTool: zod rejects javascript: URL", async () => {
  const tool = buildUiOpenUrlTool(() => {});
  const parsed = tool.parameters.safeParse({ url: "javascript:alert(1)" });
  expect(parsed.success).toBe(false);
});

test("buildUiOpenUrlTool: zod rejects file:// URL", async () => {
  const tool = buildUiOpenUrlTool(() => {});
  const parsed = tool.parameters.safeParse({ url: "file:///etc/passwd" });
  expect(parsed.success).toBe(false);
});

test("buildUiOpenUrlTool: name + approval", () => {
  const tool = buildUiOpenUrlTool(() => {});
  expect(tool.name).toBe("ui_open_url");
  expect(tool.approval).toBe("never");
});
