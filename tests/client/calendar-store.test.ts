import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { SSE_EVENTS } from "@shared/api-contracts";
import { attachSnapshotSseListeners } from "@/lib/snapshot-sse-listeners";
import { useCalendarStore } from "@/store/calendar";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";

// The client's few calendar writes, and the ping that makes a view fetch again.

afterEach(() => {
  runCleanups();
  act(() => { useCalendarStore.setState({ stamp: 0 }); });
});

function stream(): EventSource {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection() {}, onReconnect() {} });
  return source;
}
const send = (source: EventSource, type: string, data: unknown) => source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));

test("a change the server tells of, and a reconnect, make the views fetch again", () => {
  const source = stream();
  const before = useCalendarStore.getState().stamp;
  send(source, SSE_EVENTS.calendarChanged, { ids: ["cal_a"] });
  expect(useCalendarStore.getState().stamp).toBe(before + 1);
  source.dispatchEvent(new Event("open"));
  expect(useCalendarStore.getState().stamp).toBe(before + 2);
});

test("pause, resume, skip and delete go to their routes, then the views fetch again", async () => {
  const calls = mockFetch(() => jsonResponse({ entry: {} }));
  const store = useCalendarStore.getState();
  await store.pause("cal 1");
  await store.resume("cal 1");
  await store.skip("cal 1", 1_700_000_000_000);
  await store.remove("cal 1");
  expect(calls.map((c) => [c.method, c.url])).toEqual([
    ["POST", "/api/calendar/cal%201/pause"],
    ["POST", "/api/calendar/cal%201/resume"],
    ["POST", "/api/calendar/cal%201/skip"],
    ["DELETE", "/api/calendar/cal%201"]
  ]);
  expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ at: 1_700_000_000_000 });
  expect(useCalendarStore.getState().stamp).toBe(4);
});
