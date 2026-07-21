import { expect, test } from "bun:test";
import { readJson } from "@/lib/api-json";

test.each([
  { ok: true, value: 1 },
  { thread: null, messages: [] },
  { ok: true, status: "failed", error: "Login expired" },
  [{ id: "first" }]
])("readJson preserves successful response data: %j", async (payload) => {
  expect(await readJson(Response.json(payload))).toEqual(payload);
});

test.each([
  { status: 404, payload: { error: "Conversation not found" }, message: "Conversation not found" },
  { status: 200, payload: { error: "Conversation closed" }, message: "Conversation closed" },
  { status: 200, payload: { ok: false, error: "Save failed" }, message: "Save failed" },
  { status: 503, payload: { ok: true, error: "Service unavailable" }, message: "Service unavailable" },
  { status: 500, payload: { message: "Internal detail" }, message: "HTTP 500" },
  { status: 403, payload: { error: "  " }, message: "HTTP 403" },
  { status: 200, payload: { ok: false }, message: "Request failed" },
  { status: 200, payload: { error: null }, message: "Request failed" },
  { status: 200, payload: { ok: false, error: { internal: "detail" } }, message: "Request failed" }
])("readJson rejects failed envelopes: %j", async ({ status, payload, message }) => {
  await expect(readJson(Response.json(payload, { status }))).rejects.toThrow(message);
});

test.each(["<html>Proxy error</html>", "", "{broken"])(
  "readJson reports useful errors for non-JSON bodies: %j",
  async (body) => {
    await expect(readJson(new Response(body, { status: 502 }))).rejects.toThrow("HTTP 502");
    await expect(readJson(new Response(body))).rejects.toThrow("Invalid JSON response");
  }
);

test.each([null, false, 1, "unexpected"])("readJson rejects invalid API payloads: %j", async (payload) => {
  await expect(readJson(Response.json(payload))).rejects.toThrow("Invalid API response");
});

test("readJson preserves aborted and failed body reads", async () => {
  for (const failure of [new DOMException("Aborted", "AbortError"), new TypeError("Connection lost")]) {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    await expect(readJson(response)).rejects.toBe(failure);
  }
});
