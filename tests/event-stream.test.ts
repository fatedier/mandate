import { expect, test } from "bun:test";
import { mapEventStreamData } from "../src/server/modules/llm/event-stream.js";

test("an event stream's data goes through the map; event names and ids stay as they came", async () => {
  const response = new Response("event: ping\nid: 7\ndata: {\"n\":1}\n\ndata: plain\n\n", { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  const mapped = mapEventStreamData(response, (data) => data.toUpperCase());
  expect(mapped.status).toBe(200);
  expect(mapped.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(await mapped.text()).toBe("event: ping\nid: 7\ndata: {\"N\":1}\n\ndata: PLAIN\n\n");
});

test("a response that is not an event stream is passed as it is", () => {
  const response = Response.json({ ok: true });
  expect(mapEventStreamData(response, () => "changed")).toBe(response);
});

// A gateway may answer an error with its JSON body under the stream's type:
// read as a stream, the body was lost, and with it the provider's words.
test("an error response is passed as it is, whatever its content type says", async () => {
  const response = new Response("{\"type\":\"error\",\"error\":{\"message\":\"maximum context length exceeded\"}}", { status: 400, headers: { "content-type": "text/event-stream" } });
  expect(mapEventStreamData(response, () => "changed")).toBe(response);
});
