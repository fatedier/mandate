import { expect, test } from "bun:test";
import { dispatchUiAction, setNavigate } from "../src/client/routes/window/chat/ui-action-dispatcher.js";

test("ui-action-dispatcher: navigate calls registered fn", () => {
  const calls: string[] = [];
  setNavigate(((p: string) => calls.push(p)) as any);
  dispatchUiAction({ action: "navigate", payload: { path: "/projects/abc" } });
  expect(calls).toEqual(["/projects/abc"]);
});

test("ui-action-dispatcher: navigate ignored when no navigate registered", () => {
  setNavigate(null as any);
  dispatchUiAction({ action: "navigate", payload: { path: "/x" } });
});

test("ui-action-dispatcher: navigate rejects non-/ paths", () => {
  const calls: string[] = [];
  setNavigate(((p: string) => calls.push(p)) as any);
  dispatchUiAction({ action: "navigate", payload: { path: "https://evil.com" } });
  dispatchUiAction({ action: "navigate", payload: { path: "javascript:alert(1)" } });
  expect(calls.length).toBe(0);
});

test("ui-action-dispatcher: open-url accepts http(s) only", () => {
  const opens: any[] = [];
  const realOpen = globalThis.open;
  (globalThis as any).open = (url: string, ...rest: any[]) => { opens.push({ url, rest }); return null; };
  try {
    dispatchUiAction({ action: "open-url", payload: { url: "https://example.com" } });
    dispatchUiAction({ action: "open-url", payload: { url: "javascript:alert(1)" } });
    dispatchUiAction({ action: "open-url", payload: { url: "file:///etc/passwd" } });
    expect(opens.length).toBe(1);
    expect(opens[0].url).toBe("https://example.com");
  } finally { (globalThis as any).open = realOpen; }
});

test("ui-action-dispatcher: unknown action does not throw", () => {
  dispatchUiAction({ action: "ghost", payload: {} });
});
